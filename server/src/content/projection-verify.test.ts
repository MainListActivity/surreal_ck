import { describe, expect, test } from "bun:test";
import { createProjectionVerifier, verifyContentProjection, type ProjectionVerifyInput } from "./projection-verify";
import type { ContentProjectionClient } from "./reader-session";

type Row = Record<string, unknown>;

const past = () => new Date(Date.now() - 86_400_000).toISOString();
const future = () => new Date(Date.now() + 86_400_000).toISOString();

const item = (id: string, sourceId: string | null = "content_source:law", withVersion = true): Row => ({
  item: `content_item:${id}`,
  version: withVersion ? `content_version:${id}` : null,
  source: withVersion ? sourceId : null,
});
const source = (id: string, status = "active"): Row => ({ id, status });
const license = (sourceId: string, overrides: Row = {}): Row => ({
  source: sourceId,
  allowed_actions: ["read", "cite"],
  effective_from: past(),
  effective_until: future(),
  revision: 1,
  ...overrides,
});
const projectionRow = (overrides: Row = {}): Row => ({
  revision: "workspace_product_entitlement:1",
  revision_number: 1,
  digest: "sha256:digest-1",
  collections: ["fixture_core"],
  confirmed_until: future(),
  status: "active",
  ...overrides,
});

const baseInput = (overrides: Partial<ProjectionVerifyInput> = {}): ProjectionVerifyInput => ({
  workspaceDb: "ws_team",
  expected: { revisionNumber: 1, digest: "sha256:digest-1" },
  collections: [{ key: "fixture_core", label: "夹具核心" }],
  actions: ["read"],
  ...overrides,
});

/**
 * 模拟 Surreal SDK 的真实返回形状：多语句批量查询返回数组，每个 LET 一个
 * null 占位，最终 RETURN 的结果在末尾。既读 [null,...,row] 也容忍裸对象。
 */
function clientReturning(out: Row | null) {
  const queries: { sql: string; params: Record<string, unknown> | undefined }[] = [];
  const client = {
    async query(sql: string, params?: Record<string, unknown>) {
      queries.push({ sql, params });
      return [null, null, null, null, out];
    },
  } as unknown as ContentProjectionClient;
  return { client, queries };
}

describe("LCA13 内容投影核验", () => {
  test("按真实 SDK 形状解析：最终 RETURN 在数组末尾，核验参数带 workspace 与集合键", async () => {
    const { client, queries } = clientReturning({
      items: [item("a")],
      sources: [source("content_source:law")],
      licenses: [license("content_source:law")],
      projection: projectionRow(),
    });
    const result = await verifyContentProjection(baseInput(), client);
    expect(result.verdict).toBe("ok");
    expect(result.workspace.state).toBe("active");
    expect(result.workspace.matchesExpected).toBe(true);
    expect(result.collections[0]).toMatchObject({ publishedItems: 1, readableItems: 1, blockedItems: 0 });
    // 核验范围绑定到具体工作区库与权益集合键。
    expect(queries[0]!.params).toMatchObject({ key: "fixture_core", ws: "ws_team" });
  });

  test("旧修订/错位的投影行判为 projection_stale，digest 或状态不符均不放过", async () => {
    const cases: Row[] = [
      projectionRow({ digest: "sha256:other" }),
      projectionRow({ revision_number: 2 }),
      projectionRow({ status: "closed" }),
      projectionRow({ confirmed_until: past() }),
    ];
    for (const projection of cases) {
      const { client } = clientReturning({
        items: [item("a")],
        sources: [source("content_source:law")],
        licenses: [license("content_source:law")],
        projection,
      });
      const result = await verifyContentProjection(baseInput(), client);
      expect(result.verdict).toBe("projection_stale");
      expect(result.workspace.matchesExpected === false || result.workspace.state !== "active").toBe(true);
    }
  });

  test("许可过期/未生效/缺失/动作不含授权、来源停用：逐来源 fail closed 判 license_blocked", async () => {
    const cases: { name: string; licenses: Row[]; sources: Row[]; reason: string }[] = [
      { name: "expired", sources: [source("content_source:law")], licenses: [license("content_source:law", { effective_until: past() })], reason: "license_expired" },
      { name: "not_started", sources: [source("content_source:law")], licenses: [license("content_source:law", { effective_from: future() })], reason: "license_not_started" },
      { name: "missing", sources: [source("content_source:law")], licenses: [], reason: "license_missing" },
      { name: "action_denied", sources: [source("content_source:law")], licenses: [license("content_source:law", { allowed_actions: ["export"] })], reason: "action_denied" },
      { name: "inactive", sources: [source("content_source:law", "inactive")], licenses: [license("content_source:law")], reason: "source_inactive" },
    ];
    for (const fixture of cases) {
      const { client } = clientReturning({
        items: [item("a")],
        sources: fixture.sources,
        licenses: fixture.licenses,
        projection: projectionRow(),
      });
      const result = await verifyContentProjection(baseInput(), client);
      expect(result.verdict, fixture.name).toBe("license_blocked");
      expect(result.collections[0]!.sources[0]!.reason).toBe(fixture.reason);
      expect(result.collections[0]!.readableItems).toBe(0);
    }
  });

  test("多来源逐条核验：单来源许可失效只阻断其条目，不混淆整集合", async () => {
    const { client } = clientReturning({
      items: [item("a", "content_source:law"), item("b", "content_source:case")],
      sources: [source("content_source:law"), source("content_source:case")],
      licenses: [
        license("content_source:law"),
        license("content_source:case", { effective_until: past() }),
      ],
      projection: projectionRow(),
    });
    const result = await verifyContentProjection(baseInput(), client);
    expect(result.collections[0]).toMatchObject({ publishedItems: 2, readableItems: 1, blockedItems: 1 });
    const bySource = Object.fromEntries(result.collections[0]!.sources.map((s) => [s.sourceId, s]));
    expect(bySource["content_source:law"]!.valid).toBe(true);
    expect(bySource["content_source:case"]!.valid).toBe(false);
    expect(bySource["content_source:case"]!.reason).toBe("license_expired");
  });

  test("取每个来源的最新许可修订：旧修订过期但新修订有效时不误报", async () => {
    const { client } = clientReturning({
      items: [item("a")],
      sources: [source("content_source:law")],
      licenses: [
        license("content_source:law", { revision: 2 }), // 最新：仍有效
        license("content_source:law", { revision: 1, effective_until: past() }),
      ],
      projection: projectionRow(),
    });
    const result = await verifyContentProjection(baseInput(), client);
    expect(result.verdict).toBe("ok");
    expect(result.collections[0]!.readableItems).toBe(1);
  });

  test("已发布条目缺当前版本是目录事实异常 → projection_error，不算许可问题", async () => {
    const { client } = clientReturning({
      items: [item("a", null, false)],
      sources: [],
      licenses: [],
      projection: projectionRow(),
    });
    const result = await verifyContentProjection(baseInput(), client);
    expect(result.verdict).toBe("projection_error");
    expect(result.collections[0]!.sources[0]!.reason).toBe("version_missing");
  });

  test("空集合 ≠ 投影故障：无任何已发布条目判 empty_collection（内容侧未供稿）", async () => {
    const { client } = clientReturning({ items: [], sources: [], licenses: [], projection: projectionRow() });
    const result = await verifyContentProjection(baseInput(), client);
    expect(result.verdict).toBe("empty_collection");
    expect(result.collections[0]!.publishedItems).toBe(0);
  });

  test("尚无投影行（首次换票才创建）不算故障：state=absent、verdict 仍由集合决定", async () => {
    const { client } = clientReturning({
      items: [item("a")],
      sources: [source("content_source:law")],
      licenses: [license("content_source:law")],
      projection: null,
    });
    const result = await verifyContentProjection(baseInput(), client);
    expect(result.workspace.state).toBe("absent");
    expect(result.workspace.matchesExpected).toBeNull();
    expect(result.verdict).toBe("ok");
  });

  test("核验会话不可用时 createProjectionVerifier fail closed 为 unavailable，不抛错", async () => {
    // 单测环境无投影会话 → 取会话即抛错，被包装层收敛为 unavailable。
    const verify = createProjectionVerifier();
    const result = await verify(baseInput());
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("unavailable");
    expect(result!.workspace.expectedRevisionNumber).toBe(1);
  });

  test("结果形状异常（非对象/缺字段）抛错由包装层 fail closed，而不是误判成功", async () => {
    const weird = { async query() { return [null, null, null, null, "garbage"]; } } as unknown as ContentProjectionClient;
    await expect(verifyContentProjection(baseInput(), weird)).rejects.toThrow("unexpected result shape");
    const broken = { async query() { throw new Error("session down"); } } as unknown as ContentProjectionClient;
    await expect(verifyContentProjection(baseInput(), broken)).rejects.toThrow("session down");
  });
});
