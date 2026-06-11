import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import { createResourceSearchService } from "./resource-search";

type QueryCall = { sql: string; binds: Record<string, unknown> | undefined };

/**
 * 假调用者会话：按 SQL 关键字分流应答 profile / resource_item / resource_embedding，
 * 记录所有调用以证明检索只走这条 session（不碰 root / legacy 全局连接）。
 */
function fakeSession(options: {
  profile?: Record<string, unknown> | null;
  resources?: Array<Record<string, unknown>>;
  embeddings?: Array<Record<string, unknown>>;
} = {}) {
  const calls: QueryCall[] = [];
  const session = {
    async query(sql: string, binds?: Record<string, unknown>) {
      calls.push({ sql, binds });
      if (sql.includes("FROM ONLY workspace_embedding_profile")) {
        return [options.profile ?? null];
      }
      if (sql.includes("FROM resource_item")) {
        return [options.resources ?? []];
      }
      if (sql.includes("FROM resource_embedding")) {
        const embeddings = options.embeddings ?? [];
        const profileKey = binds?.profileKey as string | undefined;
        const wantIndexed = sql.includes("'indexed'") || sql.includes('"indexed"');
        return [embeddings.filter((row) =>
          (!profileKey || row.profile_key === profileKey) &&
          (!wantIndexed || row.status === "indexed"),
        )];
      }
      return [null];
    },
  } as unknown as Surreal;
  return { session, calls };
}

function resourceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "resource_item:r1",
    resource_type: "generic_note",
    title: "合同解除案例",
    summary: "法院认为解除通知到达后合同解除发生效力。",
    source_url: "https://example.com/case",
    source_title: "案例来源",
    evidence: [
      {
        text: "解除通知到达相对方后产生解除效力。",
        sourceUrl: "https://example.com/case",
        sourceTitle: "案例来源",
        capturedAt: "2026-06-01T08:00:00.000Z",
        order: 0,
      },
    ],
    tags: ["合同"],
    structured_payload: {},
    quality: "user-confirmed",
    content_hash: "c",
    evidence_hash: "e",
    source_hash: "s",
    created_by: "user:u1",
    created_at: "2026-06-01T08:00:00.000Z",
    updated_at: "2026-06-01T08:00:00.000Z",
    ...overrides,
  };
}

const NOW = () => new Date("2026-06-11T00:00:00.000Z");

describe("createResourceSearchService.searchResources", () => {
  test("关键词强命中：status=hit，结果带组合分，全部查询走调用者 session", async () => {
    const { session, calls } = fakeSession({
      profile: null,
      resources: [resourceRow()],
    });
    const service = createResourceSearchService({ session, now: NOW });

    const response = await service.searchResources({
      query: "合同解除案例",
      // 关键词全命中 + user-confirmed + 近期 → 超过默认 answerThreshold 0.72 需要向量分；
      // 纯关键词路径用调低的阈值表达「hit」band 行为。
      answerThreshold: 0.4,
    });

    expect(response.status).toBe("hit");
    expect(response.queryText).toBe("合同解除案例");
    expect(response.results).toHaveLength(1);
    expect(response.results[0]!.resource).toMatchObject({
      id: "resource_item:r1",
      resourceType: "generic_note",
      title: "合同解除案例",
    });
    expect(response.results[0]!.keywordScore).toBe(1);
    expect(calls.length).toBeGreaterThan(0);
  });

  test("向量余弦排序：确定性向量决定次序，且只混入当前 profile_key 的 indexed 向量", async () => {
    const profile = { provider: "openai", model: "m", dimensions: 2, version: "v1" };
    // profile_key 与 research-save.createEmbeddingProfileKey 一致
    const currentKey = "provider=openai|model=m|dimensions=2|version=v1";
    const { session } = fakeSession({
      profile,
      resources: [
        resourceRow({ id: "resource_item:far", title: "资料甲" }),
        resourceRow({ id: "resource_item:near", title: "资料乙" }),
        resourceRow({ id: "resource_item:other-profile", title: "资料丙" }),
      ],
      embeddings: [
        { resource: "resource_item:far", profile_key: currentKey, status: "indexed", vector: [0, 1] },
        { resource: "resource_item:near", profile_key: currentKey, status: "indexed", vector: [1, 0] },
        // 旧 profile 的完美匹配向量——必须被隔离，不得进入分数
        { resource: "resource_item:other-profile", profile_key: "provider=old|model=x|dimensions=2|version=v0", status: "indexed", vector: [1, 0] },
      ],
    });
    const provider = { async embed() { return [1, 0]; } };
    const service = createResourceSearchService({ session, embeddingProvider: provider, now: NOW });

    const response = await service.searchResources({ query: "查找资料" });

    expect(response.indexStatus).toBe("ready");
    const byId = new Map(response.results.map((item) => [item.resource.id, item]));
    expect(byId.get("resource_item:near")!.vectorScore).toBe(1);
    expect(byId.get("resource_item:far")!.vectorScore).toBe(0);
    // 旧 profile 向量未混入：该资源 vectorScore 必须是 0
    expect(byId.get("resource_item:other-profile")?.vectorScore ?? 0).toBe(0);
    expect(response.results[0]!.resource.id).toBe("resource_item:near");
  });

  test("无 profile：indexStatus=index-disabled，只用关键词；空库低分 → miss", async () => {
    const { session } = fakeSession({ profile: null, resources: [] });
    const service = createResourceSearchService({ session, now: NOW });

    const response = await service.searchResources({ query: "完全不存在的主题" });

    expect(response.status).toBe("miss");
    expect(response.indexStatus).toBe("index-disabled");
    expect(response.results).toEqual([]);
  });

  test("有 profile 但服务端未配 embedding provider：索引状态按 pending/failed 推断", async () => {
    const profile = { provider: "openai", model: "m", dimensions: 2, version: "v1" };
    const currentKey = "provider=openai|model=m|dimensions=2|version=v1";
    const pending = fakeSession({
      profile,
      resources: [resourceRow()],
      embeddings: [{ resource: "resource_item:r1", profile_key: currentKey, status: "pending" }],
    });
    const pendingResponse = await createResourceSearchService({ session: pending.session, now: NOW })
      .searchResources({ query: "合同解除案例" });
    expect(pendingResponse.indexStatus).toBe("index-pending");

    const failed = fakeSession({
      profile,
      resources: [resourceRow()],
      embeddings: [{ resource: "resource_item:r1", profile_key: currentKey, status: "failed" }],
    });
    const failedResponse = await createResourceSearchService({ session: failed.session, now: NOW })
      .searchResources({ query: "合同解除案例" });
    expect(failedResponse.indexStatus).toBe("index-error");
  });

  test("embedding provider 查询向量生成失败：indexStatus=index-error，关键词结果仍返回", async () => {
    const profile = { provider: "openai", model: "m", dimensions: 2, version: "v1" };
    const { session } = fakeSession({ profile, resources: [resourceRow()] });
    const provider = { async embed(): Promise<number[]> { throw new Error("provider 503"); } };
    const service = createResourceSearchService({ session, embeddingProvider: provider, now: NOW });

    const response = await service.searchResources({ query: "合同解除案例" });

    expect(response.indexStatus).toBe("index-error");
    expect(response.results).toHaveLength(1);
    expect(response.results[0]!.vectorScore).toBe(0);
  });

  test("阈值分 band：同一结果集按 answer/candidate 阈值落 hit / candidates / miss", async () => {
    const { session } = fakeSession({ profile: null, resources: [resourceRow()] });
    const service = createResourceSearchService({ session, now: NOW });

    const hit = await service.searchResources({ query: "合同解除案例", answerThreshold: 0.3 });
    expect(hit.status).toBe("hit");

    const candidates = await service.searchResources({
      query: "合同解除案例",
      answerThreshold: 0.99,
      candidateThreshold: 0.3,
    });
    expect(candidates.status).toBe("candidates");

    const miss = await service.searchResources({
      query: "合同解除案例",
      answerThreshold: 0.99,
      candidateThreshold: 0.98,
    });
    expect(miss.status).toBe("miss");
  });
});

describe("createResourceSearchService.getResourceDetail", () => {
  test("按 id 读取资源详情（含证据与 structuredPayload），经调用者 session", async () => {
    const calls: QueryCall[] = [];
    const session = {
      async query(sql: string, binds?: Record<string, unknown>) {
        calls.push({ sql, binds });
        if (sql.includes("FROM ONLY $resourceId")) return [resourceRow()];
        if (sql.includes("FROM research_session")) return [["research_session:s1"]];
        return [null];
      },
    } as unknown as Surreal;
    const service = createResourceSearchService({ session, now: NOW });

    const { resource } = await service.getResourceDetail({ resourceId: "resource_item:r1" });

    expect(resource).toMatchObject({
      id: "resource_item:r1",
      resourceType: "generic_note",
      title: "合同解除案例",
      structuredPayload: {},
    });
    expect(resource.evidence[0]!.text).toContain("解除通知");
    // 绑定的是 RecordId 包装值，不是裸字符串
    const detailCall = calls.find((call) => call.sql.includes("FROM ONLY $resourceId"));
    expect(String(detailCall!.binds!.resourceId)).toBe("resource_item:r1");
  });

  test("资源不存在：抛错而不是返回空对象", async () => {
    const session = {
      async query() {
        return [null];
      },
    } as unknown as Surreal;
    const service = createResourceSearchService({ session, now: NOW });

    await expect(service.getResourceDetail({ resourceId: "resource_item:missing" }))
      .rejects.toThrow(/资源不存在/);
  });
});

describe("createResourceSearchService.createResearchSession", () => {
  test("用调用者 session CREATE research_session（created_by 由 schema DEFAULT $auth 归因）", async () => {
    const calls: QueryCall[] = [];
    const session = {
      async query(sql: string, binds?: Record<string, unknown>) {
        calls.push({ sql, binds });
        if (sql.includes("CREATE")) {
          return [{
            id: "research_session:s1",
            query: (binds!.content as Record<string, unknown>).query,
            resource_type: (binds!.content as Record<string, unknown>).resource_type,
            status: "open",
            context: {},
            created_resources: [],
            created_at: "2026-06-11T00:00:00.000Z",
            updated_at: "2026-06-11T00:00:00.000Z",
          }];
        }
        return [null];
      },
    } as unknown as Surreal;
    const service = createResourceSearchService({ session, now: NOW });

    const { session: created } = await service.createResearchSession({
      query: "查找合同解除案例",
      resourceType: "generic_note",
      context: { manualText: "补充说明" },
      originatingRunId: "run-1",
    });

    expect(created.id).toBe("research_session:s1");
    expect(created.query).toBe("查找合同解除案例");
    expect(created.resourceType).toBe("generic_note");
    expect(created.status).toBe("open");

    const createCall = calls.find((call) => call.sql.includes("CREATE"));
    const content = createCall!.binds!.content as Record<string, unknown>;
    expect(content).toMatchObject({
      query: "查找合同解除案例",
      resource_type: "generic_note",
      status: "open",
      originating_run_id: "run-1",
    });
    // 归因走 $auth：服务不得手工写 created_by
    expect(content.created_by).toBeUndefined();
  });

  test("query 为空：拒绝创建检索会话", async () => {
    const session = { async query() { return [null]; } } as unknown as Surreal;
    const service = createResourceSearchService({ session, now: NOW });

    await expect(service.createResearchSession({ query: "  ", resourceType: "generic_note" }))
      .rejects.toThrow(/检索问题不能为空/);
  });
});
