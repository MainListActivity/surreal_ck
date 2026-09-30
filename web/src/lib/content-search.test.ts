import { describe, expect, test } from "bun:test";
import type { ContentSearchExchangeSuccess } from "@surreal-ck/shared";
import { createContentSearch, type LegalSearchFilters } from "./content-search";

const filters: LegalSearchFilters = { keyword: "甲", kind: "legislation", publishedFrom: "", publishedUntil: "", jurisdiction: "", effectiveOn: "" };
const lease: ContentSearchExchangeSuccess = {
  status: "ready", contractId: "content_reader.v1", tokenType: "Bearer", accessToken: "synthetic",
  expiresInSeconds: 120, namespace: "main", database: "platform_content", workspaceId: "ws_a",
  entitlementRevision: "1", digest: "sha256:fixture", leaseEndSeconds: 1_000_120,
};

describe("browser authorized content search", () => {
  test("uses separate content session, paginates and counts only returned rows", async () => {
    const calls: string[] = [];
    const search = createContentSearch({
      exchange: async () => lease, workspaceDb: () => "ws_a", nowSeconds: () => 1_000_000,
      surrealUrl: "wss://example.invalid/rpc",
      connect: () => ({
        async connect(_url, scope) { calls.push(`connect:${scope.database}`); },
        async authenticate(token) { calls.push(`auth:${token}`); },
        query(sql, bindings) {
          calls.push(sql.includes("count()") ? "count" : `page:${String(bindings?.cursor ?? "first")}`);
          return { async collect() {
            if (sql.includes("count()")) return [[{ total: 21 }]];
            const start = bindings?.cursor ? 20 : 0;
            return [Array.from({ length: bindings?.cursor ? 1 : 21 }, (_, index) => ({
              id: `content_search_facet:${start + index}`, version_id: `content_version:${start + index}`,
              public_id: `law-${start + index}`, title: "甲法", revision: 1,
              kind: "legislation", source_url: "https://example.invalid", published_on: "2026-01-01",
            }))];
          } };
        },
        async close() { calls.push("close"); },
      }),
    });
    expect(await search.open()).toBe("ready");
    const first = await search.search(filters);
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBe("content_search_facet:19");
    expect(first.total).toBe(21);
    expect((await search.search(filters, first.nextCursor)).items).toHaveLength(1);
    expect(calls).toContain("connect:platform_content");
    expect(calls).toContain("auth:synthetic");
    await search.close();
    expect(calls.at(-1)).toBe("close");
  });

  test("expired or switched workspace does not reuse a content token", async () => {
    let workspace = "ws_a";
    let now = 1_000_000;
    const search = createContentSearch({
      exchange: async () => lease, workspaceDb: () => workspace, nowSeconds: () => now,
      surrealUrl: "wss://example.invalid/rpc",
      connect: () => ({ async connect() {}, async authenticate() {}, query() { return { async collect() { return [[]]; } }; }, async close() {} }),
    });
    expect(await search.open()).toBe("ready");
    workspace = "ws_b";
    await expect(search.search(filters)).rejects.toThrow("expired");
    workspace = "ws_a";
    expect(await search.open()).toBe("ready");
    now = 1_000_120;
    await expect(search.search(filters)).rejects.toThrow("expired");
  });

  test("distinguishes absent entitlement from platform failure", async () => {
    const base = { workspaceDb: () => "ws_a", nowSeconds: () => 1_000_000, surrealUrl: "wss://example.invalid/rpc", connect: () => { throw new Error("unexpected"); } };
    expect(await createContentSearch({ ...base, exchange: async () => ({ ok: false, error: "action_denied" }) }).open()).toBe("not_authorized");
    expect(await createContentSearch({ ...base, exchange: async () => { throw new Error("offline"); } }).open()).toBe("unavailable");
    expect(await createContentSearch({ ...base, exchange: async () => ({ status: "empty" }) }).open()).toBe("empty");
  });
});
