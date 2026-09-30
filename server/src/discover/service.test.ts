import { describe, expect, test } from "bun:test";
import { createDiscoverService, type Queryable } from "./service";

/**
 * LCA11 领域逻辑单测：fake Queryable 记录 SQL 与参数，
 * 验证投影准入、覆盖结论、单一建议与事件结构化约束。
 */

type Call = { sql: string; params?: Record<string, unknown> };

function fakeQueryable(respond: (sql: string, params?: Record<string, unknown>) => unknown[]): { q: Queryable; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    q: {
      async query(sql: string, params?: Record<string, unknown>) {
        calls.push({ sql, params });
        return [respond(sql, params)];
      },
    },
  };
}

const NOW = new Date("2026-09-30T00:00:00Z");

function fixtureContent(options?: { licenses?: Record<string, unknown>[]; bindings?: Record<string, unknown>[]; facetOverrides?: Partial<Record<string, unknown>> }) {
  const discoverItems: Record<string, unknown>[] = [];
  const facet = {
    item: "content_item:i1",
    version: "content_version:v1",
    kind: "legislation",
    jurisdiction: "CN",
    published_on: "2025-01-01",
    public_id: "i1",
    title: "建设工程司法解释",
    source: "content_source:s1",
    ...(options?.facetOverrides ?? {}),
  };
  const sources = [
    { id: "content_source:s1", source_key: "s1", label: "最高法公报", status: "active" },
    { id: "content_source:s2", source_key: "s2", label: "案例库", status: "active" },
  ];
  const licenses = options?.licenses ?? [
    { id: "source_license_revision:l1", source: "content_source:s1", revision: 1, allowed_actions: ["publish", "discover", "read"], effective_from: "2026-01-01T00:00:00Z", effective_until: null },
    { id: "source_license_revision:l2", source: "content_source:s2", revision: 1, allowed_actions: ["publish", "read"], effective_from: "2026-01-01T00:00:00Z", effective_until: null },
  ];
  const bindings = options?.bindings ?? [
    { item: "content_item:i1", collections: ["core_statutes"] },
  ];
  return {
    discoverItems,
    handle(sql: string, params?: Record<string, unknown>): unknown[] {
      if (sql.includes("FROM content_search_facet")) return [facet];
      if (sql.includes("FROM content_source")) return sources;
      if (sql.includes("FROM source_license_revision")) return licenses;
      if (sql.includes("FROM content_collection_binding")) return bindings;
      if (sql.includes("INSERT INTO content_discover_item")) {
        discoverItems.push({ ...(params ?? {}), listed: true });
        return [];
      }
      if (sql.includes("SELECT id, item, listed FROM content_discover_item")) {
        return discoverItems.map((row, index) => ({ id: `content_discover_item:d${index}`, item: row.item, listed: row.listed }));
      }
      if (sql.includes("UPDATE $id SET listed = false")) {
        const target = discoverItems.find((row, index) => `content_discover_item:d${index}` === String(params?.id));
        if (target) target.listed = false;
        return [];
      }
      if (sql.includes("FROM content_discover_item")) return discoverItems.filter((row) => row.listed === true);
      if (sql.includes("INSERT INTO content_discover_example")) return [];
      if (sql.includes("FROM content_discover_example")) return [
        { example_key: "ex1", title: "示例：合同解除通知", summary: "策划示例摘要", citation_labels: ["示例法条 X"] },
      ];
      if (sql.includes("INSERT INTO discover_event")) return [];
      return [];
    },
  };
}

function fakeSystem(overrides?: Partial<Record<string, unknown[]>>): { q: Queryable; calls: Call[] } {
  return fakeQueryable((sql) => {
    for (const [needle, value] of Object.entries(overrides ?? {})) {
      if (sql.includes(needle)) return value;
    }
    if (sql.includes("FROM workspace WHERE")) return [{ id: "workspace:w1", db_name: "ws_acme", status: "active" }];
    if (sql.includes("FROM user_workspace_index")) return [{ subject: "alice", disabled_at: null }];
    if (sql.includes("FROM product_plan")) return [
      { plan_key: "lawyer_pro", plan_name: "Pro", collections: [{ collection_key: "core_statutes" }, { collection_key: "core_cases" }] },
      { plan_key: "lawyer_plus", plan_name: "Plus", collections: [{ collection_key: "core_statutes" }] },
    ];
    if (sql.includes("quota_subscription_item")) return ["billing_account:b1"];
    if (sql.includes("billing_account_member")) return ["admin"];
    return [];
  });
}

function serviceWith(content: ReturnType<typeof fixtureContent>, system: { q: Queryable }, collections: string[]) {
  return createDiscoverService({
    content: fakeQueryable(content.handle).q,
    system: system.q,
    entitlementStore: { async currentSnapshot() { return { collections: collections.map((key) => ({ key, label: key })) }; } },
    now: () => NOW,
  });
}

describe("discover projection rebuild", () => {
  test("许可含 discover 且生效中的已发布条目进入投影；缺许可/不含 discover 的条目不进入", async () => {
    const content = fixtureContent({
      facetOverrides: {},
      bindings: [
        { item: "content_item:i1", collections: ["core_statutes"] },
        { item: "content_item:i2", collections: ["core_cases"] },
      ],
    });
    // i2 挂在 s2（许可没有 discover）→ 不进入投影
    const service = serviceWith(content, fakeSystem(), []);
    // 让 facet 查询返回两个条目
    const original = content.handle.bind(content);
    content.handle = (sql, params) => sql.includes("FROM content_search_facet")
      ? [ ...original(sql, params) as Record<string, unknown>[],
          { item: "content_item:i2", version: "content_version:v2", kind: "judicial_document", jurisdiction: "CN", published_on: "2025-06-01", public_id: "i2", title: "隐藏案例", source: "content_source:s2" } ]
      : original(sql, params);

    const result = await service.rebuildProjection("ops:test", { examples: [{ key: "ex1", title: "示例", summary: "摘要", citationLabels: [], position: 0 }], reason: "rebuild" });
    expect(result.listed).toBe(1);
    expect(content.discoverItems).toHaveLength(1);
    expect(content.discoverItems[0]?.publicId).toBe("i1");
    expect(content.discoverItems[0]?.item?.toString()).toBe("content_item:i1");
    expect(JSON.stringify(content.discoverItems)).not.toContain("隐藏案例");
    expect(JSON.stringify(content.discoverItems)).not.toContain("content_item:i2");
  });

  test("已失效条目重建时 listed=false 下架而不是删除", async () => {
    const content = fixtureContent({ licenses: [] }); // 许可未知 → 全部下架
    content.discoverItems.push({ item: "content_item:i1", publicId: "i1", listed: true });
    const service = serviceWith(content, fakeSystem(), []);
    const result = await service.rebuildProjection("ops:test", { examples: [], reason: "r" });
    expect(result.delisted).toBe(1);
    expect(content.discoverItems[0]?.listed).toBe(false);
  });

  test("许可到期同样不进入投影", async () => {
    const content = fixtureContent({
      licenses: [{ id: "source_license_revision:l1", source: "content_source:s1", revision: 1, allowed_actions: ["discover"], effective_from: "2020-01-01T00:00:00Z", effective_until: "2020-12-31T00:00:00Z" }],
    });
    const service = serviceWith(content, fakeSystem(), []);
    const result = await service.rebuildProjection("ops:test", { examples: [], reason: "r" });
    expect(result.listed).toBe(0);
    expect(content.discoverItems).toHaveLength(0);
  });
});

describe("public query", () => {
  test("命中条目只返回安全元数据；锁定正文标记不进入输出", async () => {
    const content = fixtureContent();
    content.discoverItems.push({
      publicId: "i1", kind: "legislation", title: "建设工程司法解释",
      jurisdiction: "CN", published_on: "2025-01-01", source_label: "最高法公报",
      collections: ["core_statutes"], listed: true,
    });
    const service = serviceWith(content, fakeSystem(), []);
    const result = await service.publicQuery("建设工程价款优先受偿权");
    expect(result.scope.matchedCount).toBe(1);
    expect(result.scope.collectionKeys).toEqual(["core_statutes"]);
    expect(result.matchedItems[0]?.title).toBe("建设工程司法解释");
    const raw = JSON.stringify(result);
    expect(raw).not.toContain("body");
    expect(raw).not.toContain("LOCKED_TEXT_MARKER");
    expect(result.examples[0]?.title).toBe("示例：合同解除通知");
  });

  test("无命中返回空范围与示例，不编造覆盖", async () => {
    const content = fixtureContent();
    const service = serviceWith(content, fakeSystem(), []);
    const result = await service.publicQuery("完全不相关的问题词条 xyz");
    expect(result.scope.matchedCount).toBe(0);
    expect(result.matchedItems).toEqual([]);
  });
});

describe("member evaluation", () => {
  async function evaluate(collections: string[], overrides?: { system?: Partial<Record<string, unknown[]>>; items?: Record<string, unknown>[] }) {
    const content = fixtureContent();
    for (const item of overrides?.items ?? []) content.discoverItems.push(item);
    const system = fakeSystem(overrides?.system);
    const service = serviceWith(content, system, collections);
    const result = await service.evaluateMember({ question: "建设工程", subject: "alice", workspaceDb: "ws_acme" });
    return { result, calls: system.calls };
  }

  const item = {
    publicId: "i1", kind: "legislation", title: "建设工程司法解释",
    jurisdiction: "CN", published_on: "2025-01-01", source_label: "s", collections: ["core_statutes"], listed: true,
  };
  const itemGap = { ...item, publicId: "i2", title: "建设工程裁判规则", collections: ["pro_cases"] };

  test("全部命中集合已覆盖 → full，无建议", async () => {
    const { result } = await evaluate(["core_statutes"], { items: [item] });
    expect(result.coverage).toBe("full");
    expect(result.suggestion).toBeNull();
    expect(result.entry.kind).toBe("none");
  });

  test("部分覆盖 → partial + 指向覆盖缺口的单一套餐建议；计费管理员得升级入口", async () => {
    const { result } = await evaluate(["core_statutes"], { items: [item, { ...itemGap, collections: ["core_cases"] }] });
    expect(result.coverage).toBe("partial");
    expect(result.gapCollections).toEqual(["core_cases"]);
    expect(result.suggestion?.planKey).toBe("lawyer_pro");
    expect(result.entry).toEqual({ kind: "upgrade", planKey: "lawyer_pro" });
  });

  test("全部未覆盖但平台有 → locked；非管理员得 request_admin 入口", async () => {
    const { result } = await evaluate([], {
      items: [{ ...item, collections: ["core_statutes"] }],
      system: { billing_account_member: ["viewer"] },
    });
    expect(result.coverage).toBe("locked");
    // 单一缺口集合 core_statutes：lawyer_plus 即可补齐且更聚焦，优先于 lawyer_pro。
    expect(result.entry).toEqual({ kind: "request_admin", planKey: "lawyer_plus" });
  });

  test("无命中 → unavailable，不给建议不编造", async () => {
    const { result } = await evaluate(["core_statutes"], { items: [] });
    expect(result.coverage).toBe("unavailable");
    expect(result.suggestion).toBeNull();
  });

  test("缺口无套餐可覆盖 → 不建议升级，诚实证据不足", async () => {
    const { result } = await evaluate([], { items: [{ ...item, collections: ["exotic_module"] }] });
    expect(result.coverage).toBe("locked");
    expect(result.suggestion).toBeNull();
    expect(result.entry.kind).toBe("none");
  });

  test("事件只写结构化字段：SQL 参数不含问题原文", async () => {
    const content = fixtureContent();
    content.discoverItems.push(item as never);
    const calls: Call[] = [];
    const service = createDiscoverService({
      content: {
        async query(sql, params) { calls.push({ sql, params }); return [content.handle(sql, params)]; },
      },
      system: fakeSystem().q,
      entitlementStore: { async currentSnapshot() { return { collections: [] }; } },
      now: () => NOW,
    });
    await service.evaluateMember({ question: "机密案情 LOCKED_MARKER", subject: "alice", workspaceDb: "ws_acme" });
    const eventCalls = calls.filter((call) => call.sql.includes("INSERT INTO discover_event"));
    expect(eventCalls.length).toBeGreaterThan(0);
    for (const call of eventCalls) {
      expect(JSON.stringify(call.params)).not.toContain("机密案情");
      expect(JSON.stringify(call.params)).not.toContain("LOCKED_MARKER");
      expect(Object.keys(call.params ?? {}).sort()).toEqual(
        ["conversion", "kind", "moduleKey", "planKey", "scopeCollections", "scopeKinds", "subjectKind", "workspace"].sort(),
      );
    }
  });

  test("非成员 / 工作区停用被拒绝", async () => {
    const content = fixtureContent();
    const service = createDiscoverService({
      content: fakeQueryable(content.handle).q,
      system: fakeSystem({ user_workspace_index: [] }).q,
      entitlementStore: { async currentSnapshot() { return null; } },
    });
    await expect(service.evaluateMember({ question: "q", subject: "mallory", workspaceDb: "ws_acme" }))
      .rejects.toMatchObject({ code: "not-member" });
  });
});
