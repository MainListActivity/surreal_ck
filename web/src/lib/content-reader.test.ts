import { describe, expect, test } from "bun:test";
import type { ContentReaderExchangeSuccess } from "@surreal-ck/shared";
import {
  CONTENT_PAGE_QUERY,
  createContentReader,
  type ContentConnection,
  type ContentReaderDependencies,
} from "./content-reader";

const exchange: ContentReaderExchangeSuccess = {
  contractId: "content_reader.v1",
  tokenType: "Bearer",
  accessToken: "synthetic-content-token",
  expiresInSeconds: 120,
  namespace: "main",
  database: "platform_content",
  workspaceId: "ws_alpha",
  entitlementRevision: "12",
  digest: "sha256:synthetic",
  leaseEndSeconds: 1_000_120,
  contentPublicId: "law-2026-1",
};

function fixture() {
  let workspace = "ws_alpha";
  let response: ContentReaderDependencies["exchange"] = async () => exchange;
  const calls: string[] = [];
  const connection: ContentConnection = {
    async connect(_url, options) { calls.push(`connect:${options.database}`); },
    async authenticate(token) { calls.push(`authenticate:${token}`); },
    query(sql, bindings) {
      if (sql.includes("legal_article_version")) return { async collect() { return [[]]; } };
      if (sql.includes("content_reader_action")) return { async collect() { return [true]; } };
      calls.push(`query:${bindings.publicId}`);
      expect(sql).toBe(CONTENT_PAGE_QUERY);
      return { async collect() {
        return [[{
          id: "content_version:law",
          public_id: "law-2026-1", title: "已发布法条", revision: 3,
          version_label: "2026 修订", source_url: "https://source.example/law",
          source_form: "official", published_at: "2026-09-01T00:00:00Z",
          body_text: "合成正文",
          evidence: "never render",
        }]];
      } };
    },
    async close() { calls.push("close"); },
  };
  const reader = createContentReader({
    surrealUrl: "wss://db.example/rpc",
    nowSeconds: () => 1_000_000,
    workspaceDb: () => workspace,
    exchange: (id) => response(id),
    connect: () => connection,
  });
  return {
    reader, calls,
    setWorkspace(value: string) { workspace = value; },
    setExchange(value: ContentReaderDependencies["exchange"]) { response = value; },
  };
}

describe("independent content reader", () => {
  test("uses a second connection and returns only published content display fields", async () => {
    const f = fixture();
    const result = await f.reader.open("law-2026-1", "ws_alpha");
    expect(result).toMatchObject({ ok: true, page: {
      title: "已发布法条", revision: 3, versionLabel: "2026 修订",
      bodyText: "合成正文", authorizedUntilSeconds: 1_000_120,
    } });
    expect(f.calls).toEqual([
      "connect:platform_content", "authenticate:synthetic-content-token", "query:law-2026-1",
    ]);
    expect(JSON.stringify(result)).not.toContain("never render");
    await f.reader.close();
    expect(f.calls.at(-1)).toBe("close");
  });

  test("denied exchange never connects or exposes a previous body", async () => {
    const f = fixture();
    expect((await f.reader.open("law-2026-1", "ws_alpha")).ok).toBe(true);
    f.setExchange(async () => ({ ok: false, error: "member_removed" }));
    expect(await f.reader.open("law-2026-1", "ws_alpha")).toEqual({ ok: false, reason: "member_removed" });
    expect(f.calls.filter(call => call.startsWith("query:"))).toHaveLength(1);
    expect(f.calls.filter(call => call === "close")).toHaveLength(1);
  });

  test("workspace switch during exchange rejects the old authorization", async () => {
    const f = fixture();
    f.setExchange(async () => {
      f.setWorkspace("ws_beta");
      return exchange;
    });
    expect(await f.reader.open("law-2026-1", "ws_alpha")).toEqual({ ok: false, reason: "workspace_changed" });
    expect(f.calls).toEqual([]);
  });

  test("overlong lease and wrong pointer fail before opening content connection", async () => {
    const f = fixture();
    f.setExchange(async () => ({ ...exchange, leaseEndSeconds: 1_001_000 }));
    expect(await f.reader.open("law-2026-1", "ws_alpha")).toEqual({ ok: false, reason: "session_expired" });
    f.setExchange(async () => ({ ...exchange, contentPublicId: "different" }));
    expect(await f.reader.open("law-2026-1", "ws_alpha")).toEqual({ ok: false, reason: "content_unavailable" });
    expect(f.calls).toEqual([]);
  });
});
