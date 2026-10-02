import { describe, expect, test } from "bun:test";
import type { SessionUser } from "@surreal-ck/shared";
import { createContentReaderExchangeHandler } from "./reader-handler";
import type { ContentReaderProjectionWrite } from "./reader-exchange";

const NOW = 1_780_000_000;

const caller: SessionUser = {
  subject: "human",
  raw: { db: "ws_alpha", ac: "participant", exp: NOW + 5_000 },
  rawToken: "workspace-token",
};

const indexRows = [
  { subject: "human", disabled_at: null, workspace: { id: "workspace:w1", status: "active" } },
  { subject: "admin", disabled_at: null, workspace: { id: "workspace:w1", status: "active" } },
  { subject: "gone", disabled_at: new Date("2026-09-01"), workspace: { id: "workspace:w1", status: "active" } },
  { subject: null, disabled_at: null, workspace: { id: "workspace:w1", status: "active" } },
];

const snapshot = {
  revision: 7,
  digest: "sha256:ent",
  resolverVersion: "product-entitlement-v1",
  effectiveUntil: null,
  collections: [{ key: "core", label: "核心" }],
  actions: ["browse", "read"],
  aiActions: [],
};

// fetchContentReaderTarget 的 RETURN 原始形状（未映射）。
const targetRow = {
  version: "content_version:v",
  item: "content_item:i",
  source_status: "active",
  publication_status: "published",
  license: "source_license_revision:l",
  license_actions: ["browse", "read", "cite"],
  license_from: new Date((NOW - 100) * 1000).toISOString(),
  license_until: null,
  collections: ["core"],
};

function fixture(overrides: {
  indexRows?: unknown[];
  workspaceUsers?: unknown[];
  snapshot?: unknown;
  content?: unknown;
  idpResult?: unknown;
  caller?: SessionUser;
  /** LCA-14：灰度开关行（undefined = 行缺失 = on）。 */
  capabilitySwitch?: { mode: "on" | "cohort" | "off"; workspaces?: string[] };
} = {}) {
  const queries: string[] = [];
  const writes: ContentReaderProjectionWrite[] = [];
  const handler = createContentReaderExchangeHandler({
    nowSeconds: () => NOW,
    database: "platform_content",
    namespace: "main",
    getSystemDb: async () => ({
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("LET $sw")) {
          const sw = overrides.capabilitySwitch;
          return [null, null, {
            mode: sw?.mode ?? "on",
            workspaces: sw?.workspaces ?? [],
            slug: "ws-alpha",
          }];
        }
        return [overrides.indexRows ?? indexRows];
      },
    }),
    getWorkspaceDb: async () => ({
      async query(sql: string) {
        queries.push(sql);
        return [overrides.workspaceUsers ?? [{ id: "user:human" }]];
      },
    }),
    entitlementStore: {
      async currentSnapshot() {
        return (overrides.snapshot === undefined ? snapshot : overrides.snapshot) as never;
      },
    },
    getContentDb: async () => ({
      async query(sql: string, params?: Record<string, unknown>) {
        queries.push(sql);
        if (sql.includes("UPSERT")) {
          writes.push(params as unknown as ContentReaderProjectionWrite);
          return [null, null];
        }
        return [null, null, null, null, overrides.content === undefined ? targetRow : overrides.content];
      },
    }),
    idpContentReader: {
      async exchangeContentReaderScope() {
        return (overrides.idpResult ?? { accessToken: "content-token", expiresIn: 120 }) as never;
      },
    },
  });
  return { handler, queries, writes };
}

// writeProjection 由 handler 内部接 writeContentReaderProjection；这里用真函数签名替换验证调用。
describe("content reader exchange handler wiring", () => {
  test("成员+权益+内容事实组装成一次换票并写投影", async () => {
    const { handler, queries } = fixture();
    const result = await handler(caller, { contentPublicId: "law-1" });
    expect(result).toMatchObject({
      contractId: "content_reader.v1",
      tokenType: "Bearer",
      accessToken: "content-token",
      expiresInSeconds: 120,
      database: "platform_content",
      workspaceId: "ws_alpha",
      entitlementRevision: "7",
      contentPublicId: "law-1",
    });
    expect(queries.some((sql) => sql.includes("user_workspace_index"))).toBe(true);
    expect(queries.some((sql) => sql.includes("content_version"))).toBe(true);
  });

  test("成功换票把投影与门禁写入受限会话", async () => {
    const { handler, writes } = fixture();
    await handler(caller, { contentPublicId: "law-1" });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      workspaceId: "ws_alpha",
      revision: "7",
      revisionNumber: 7,
      digest: "sha256:ent",
      gateActions: ["browse", "read"],
      gateAiActions: [],
      allowedSubjects: ["human", "admin"],
    });
  });

  test("非成员、移除成员、无权益、内容缺失各自拒绝", async () => {
    expect(await fixture({ indexRows: [] }).handler(caller, { contentPublicId: "law-1" }))
      .toEqual({ ok: false, error: "workspace_inactive" });
    const stranger = [{ subject: "other", disabled_at: null, workspace: { id: "workspace:w1", status: "active" } }];
    expect(await fixture({ indexRows: stranger }).handler(caller, { contentPublicId: "law-1" }))
      .toEqual({ ok: false, error: "not_member" });
    const removed = [{ subject: "human", disabled_at: new Date(), workspace: { id: "workspace:w1", status: "active" } }];
    expect(await fixture({ indexRows: removed }).handler(caller, { contentPublicId: "law-1" }))
      .toEqual({ ok: false, error: "member_removed" });
    expect(await fixture({ workspaceUsers: [] }).handler(caller, { contentPublicId: "law-1" }))
      .toEqual({ ok: false, error: "member_removed" });
    expect(await fixture({ snapshot: null }).handler(caller, { contentPublicId: "law-1" }))
      .toEqual({ ok: false, error: "entitlement_absent" });
    expect(await fixture({ content: null }).handler(caller, { contentPublicId: "law-1" }))
      .toEqual({ ok: false, error: "content_not_published" });
  });

  test("content_reader 自身 token 与过期 subject token 不发票", async () => {
    const readerCaller: SessionUser = { subject: "human", raw: { db: "ws_alpha", ac: "content_reader", exp: NOW + 500 }, rawToken: "t" };
    expect(await fixture().handler(readerCaller, { contentPublicId: "law-1" }))
      .toEqual({ ok: false, error: "idp_rejected" });
    const expired: SessionUser = { subject: "human", raw: { db: "ws_alpha", ac: "participant", exp: NOW - 5 }, rawToken: "t" };
    expect(await fixture().handler(expired, { contentPublicId: "law-1" }))
      .toEqual({ ok: false, error: "invalid_lifetime" });
  });

  test("IdP 拒绝时不写投影", async () => {
    const result = await fixture({ idpResult: { error: "invalid_scope" } }).handler(caller, { contentPublicId: "law-1" });
    expect(result).toEqual({ ok: false, error: "idp_rejected", idpError: "invalid_scope" });
  });

  test("LCA-14：内容灰度开关 off / cohort 未命中 → capability_disabled，不查成员不换票", async () => {
    const off = await fixture({ capabilitySwitch: { mode: "off" } }).handler(caller, { contentPublicId: "law-1" });
    expect(off).toEqual({ ok: false, error: "capability_disabled" });

    const cohortMiss = await fixture({ capabilitySwitch: { mode: "cohort", workspaces: ["other-ws"] } })
      .handler(caller, { contentPublicId: "law-1" });
    expect(cohortMiss).toEqual({ ok: false, error: "capability_disabled" });

    // cohort 命中照常走完整链路。
    const cohortHit = await fixture({ capabilitySwitch: { mode: "cohort", workspaces: ["ws-alpha"] } })
      .handler(caller, { contentPublicId: "law-1" });
    expect(cohortHit).toMatchObject({ contractId: "content_reader.v1" });
  });
});
