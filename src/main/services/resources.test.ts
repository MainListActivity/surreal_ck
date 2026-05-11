import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import {
  createEmbeddingProfileKey,
  createResourceService,
  type ResourceRepository,
  type ResourceRow,
  type ResourceEmbeddingRow,
  type ResourceEmbeddingProfile,
  type ResearchSessionRow,
} from "./resources";
import { ServiceError } from "./errors";

class MemoryResourceRepository implements ResourceRepository {
  private resourceSeq = 0;
  private sessionSeq = 0;
  readonly resources = new Map<string, ResourceRow>();
  readonly sessions = new Map<string, ResearchSessionRow>();
  readonly embeddings = new Map<string, ResourceEmbeddingRow>();

  async createResource(input: Omit<ResourceRow, "id">): Promise<ResourceRow> {
    const row = { id: new RecordId("resource_item", `r${++this.resourceSeq}`), ...input };
    this.resources.set(String(row.id), row);
    return row;
  }

  async findResourceById(resourceId: string): Promise<ResourceRow | null> {
    return this.resources.get(resourceId) ?? null;
  }

  async upsertResourceEmbedding(input: Omit<ResourceEmbeddingRow, "id">): Promise<ResourceEmbeddingRow> {
    const key = `${String(input.resource)}|${input.profile_key}`;
    const current = this.embeddings.get(key);
    const row = current
      ? { ...current, ...input }
      : { id: new RecordId("resource_embedding", `e${this.embeddings.size + 1}`), ...input };
    this.embeddings.set(key, row);
    return row;
  }

  async findResourceEmbeddingsByResource(resourceId: string): Promise<ResourceEmbeddingRow[]> {
    return [...this.embeddings.values()].filter((row) => String(row.resource) === resourceId);
  }

  async listIndexedResourceEmbeddings(workspaceId: string, profileKey: string): Promise<ResourceEmbeddingRow[]> {
    return [...this.embeddings.values()].filter((row) =>
      String(row.workspace) === workspaceId &&
      row.profile_key === profileKey &&
      row.status === "indexed"
    );
  }

  async markResourceEmbeddingsStaleForWorkspace(
    workspaceId: string,
    activeProfileKey: string,
    updatedAt: Date,
  ): Promise<number> {
    let count = 0;
    for (const [key, row] of this.embeddings) {
      if (
        String(row.workspace) !== workspaceId ||
        row.profile_key === activeProfileKey ||
        !["pending", "indexed", "failed"].includes(row.status)
      ) {
        continue;
      }
      this.embeddings.set(key, { ...row, status: "stale", updated_at: updatedAt });
      count += 1;
    }
    return count;
  }

  async createResearchSession(input: Omit<ResearchSessionRow, "id">): Promise<ResearchSessionRow> {
    const row = { id: new RecordId("research_session", `s${++this.sessionSeq}`), ...input };
    this.sessions.set(String(row.id), row);
    return row;
  }

  async findResearchSessionById(sessionId: string): Promise<ResearchSessionRow | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async updateResearchSession(sessionId: string, patch: Partial<Omit<ResearchSessionRow, "id">>): Promise<ResearchSessionRow | null> {
    const current = this.sessions.get(sessionId);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.sessions.set(sessionId, next);
    return next;
  }
}

function createTestService(repo = new MemoryResourceRepository(), overrides: Record<string, unknown> = {}) {
  const canRead: string[] = [];
  const canWrite: string[] = [];
  const service = createResourceService({
    repository: repo,
    assertCanReadWorkspace: async (workspaceId) => {
      canRead.push(workspaceId);
    },
    assertCanWriteWorkspace: async (workspaceId) => {
      canWrite.push(workspaceId);
    },
    getCurrentUserRecordId: async () => new RecordId("app_user", "u1"),
    now: () => new Date("2026-05-11T08:00:00.000Z"),
    ...overrides,
  });
  return { service, repo, canRead, canWrite };
}

function createRejectingReadService(repo = new MemoryResourceRepository()) {
  const service = createResourceService({
    repository: repo,
    assertCanReadWorkspace: async (workspaceId) => {
      throw new ServiceError("NOT_FOUND", `blocked ${workspaceId}`);
    },
    assertCanWriteWorkspace: async () => undefined,
    getCurrentUserRecordId: async () => new RecordId("app_user", "u1"),
    now: () => new Date("2026-05-11T08:00:00.000Z"),
  });
  return { service, repo };
}

const EMBEDDING_PROFILE: ResourceEmbeddingProfile = {
  provider: "openai",
  model: "text-embedding-3-small",
  dimensions: 3,
  version: "2026-05-11",
};

const ALTERNATE_EMBEDDING_PROFILE: ResourceEmbeddingProfile = {
  provider: "openai",
  model: "text-embedding-3-large",
  dimensions: 3,
  version: "2026-05-11",
};

describe("资源主数据闭环", () => {
  test("embedding profile key 稳定区分 provider、model、dimensions 和版本", () => {
    const profile = {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      version: "2026-05-11",
    };

    expect(createEmbeddingProfileKey(profile)).toBe(createEmbeddingProfileKey({ ...profile }));
    expect(createEmbeddingProfileKey({ ...profile, provider: "custom" })).not.toBe(createEmbeddingProfileKey(profile));
    expect(createEmbeddingProfileKey({ ...profile, model: "text-embedding-3-large" })).not.toBe(createEmbeddingProfileKey(profile));
    expect(createEmbeddingProfileKey({ ...profile, dimensions: 3072 })).not.toBe(createEmbeddingProfileKey(profile));
    expect(createEmbeddingProfileKey({ ...profile, version: "2026-05-12" })).not.toBe(createEmbeddingProfileKey(profile));
  });

  test("保存 generic_note 后可读取最小资源详情", async () => {
    const { service, canRead, canWrite } = createTestService();

    const saved = await service.saveResource({
      workspaceId: "workspace:demo",
      resourceType: "generic_note",
      title: "相似案件检索策略",
      summary: "先用争议焦点和裁判要旨做关键词，再补充法条。",
      sourceTitle: "研究笔记",
      evidence: [
        {
          text: "争议焦点比案号更适合做第一轮召回。",
          sourceTitle: "研究笔记",
          capturedAt: "2026-05-11T07:59:00.000Z",
          order: 0,
        },
      ],
      tags: ["case-search", "strategy"],
      structuredPayload: {},
      quality: "user-confirmed",
    });

    const detail = await service.getResourceDetail({ resourceId: saved.resource.id });

    expect(saved.resource).toMatchObject({
      id: "resource_item:r1",
      workspaceId: "workspace:demo",
      resourceType: "generic_note",
      title: "相似案件检索策略",
      quality: "user-confirmed",
      sourceTitle: "研究笔记",
      structuredPayload: {},
      createdBy: "app_user:u1",
      createdAt: "2026-05-11T08:00:00.000Z",
      updatedAt: "2026-05-11T08:00:00.000Z",
    });
    expect(detail.resource.evidence).toEqual(saved.resource.evidence);
    expect(detail.resource.duplicateHashes.content).toHaveLength(64);
    expect(detail.resource.duplicateHashes.evidence).toHaveLength(64);
    expect(detail.resource.duplicateHashes.source).toHaveLength(64);
    expect(detail.session).toBeUndefined();
    expect(canWrite).toEqual(["workspace:demo"]);
    expect(canRead).toEqual(["workspace:demo"]);
  });

  test("没有 embedding 配置时资源保存成功并暴露 disabled 状态", async () => {
    const { service } = createTestService();

    const saved = await service.saveResource({
      workspaceId: "workspace:demo",
      resourceType: "generic_note",
      title: "无需索引也能保存",
      summary: "embedding 未配置不应阻断资源主数据保存。",
      evidence: [],
      structuredPayload: {},
      quality: "user-confirmed",
    });
    const detail = await service.getResourceDetail({ resourceId: saved.resource.id });

    expect(saved.resource.embedding).toEqual({ status: "disabled" });
    expect(detail.resource.embedding).toEqual({ status: "disabled" });
  });

  test("配置 embedding profile 后资源保存创建独立 pending 索引状态", async () => {
    const profileKey = createEmbeddingProfileKey(EMBEDDING_PROFILE);
    const { service, repo } = createTestService(new MemoryResourceRepository(), {
      getActiveEmbeddingProfile: async () => EMBEDDING_PROFILE,
    });

    const saved = await service.saveResource({
      workspaceId: "workspace:demo",
      resourceType: "generic_note",
      title: "待索引资料",
      summary: "有 profile 时保存后进入 pending 索引状态。",
      evidence: [],
      structuredPayload: {},
      quality: "user-confirmed",
    });
    const detail = await service.getResourceDetail({ resourceId: saved.resource.id });

    expect(saved.resource.embedding).toMatchObject({
      status: "pending",
      profileKey,
      provider: EMBEDDING_PROFILE.provider,
      model: EMBEDDING_PROFILE.model,
      dimensions: EMBEDDING_PROFILE.dimensions,
      version: EMBEDDING_PROFILE.version,
    });
    expect(detail.resource.embedding).toEqual(saved.resource.embedding);
    expect(repo.resources.has(saved.resource.id)).toBe(true);
    expect(repo.embeddings.size).toBe(1);
  });

  test("embedding 生成成功后同一 profile 的索引状态变为 indexed", async () => {
    const profileKey = createEmbeddingProfileKey(EMBEDDING_PROFILE);
    const { service, repo } = createTestService(new MemoryResourceRepository(), {
      getActiveEmbeddingProfile: async () => EMBEDDING_PROFILE,
      generateEmbedding: async () => [0.1, 0.2, 0.3],
    });

    const saved = await service.saveResource({
      workspaceId: "workspace:demo",
      resourceType: "generic_note",
      title: "成功索引资料",
      summary: "生成向量后状态应为 indexed。",
      evidence: [],
      structuredPayload: {},
      quality: "user-confirmed",
    });
    const embeddingRows = [...repo.embeddings.values()];

    expect(saved.resource.embedding).toMatchObject({
      status: "indexed",
      profileKey,
      indexedAt: "2026-05-11T08:00:00.000Z",
    });
    expect(embeddingRows).toHaveLength(1);
    expect(embeddingRows[0]).toMatchObject({
      resource: new RecordId("resource_item", "r1"),
      profile_key: profileKey,
      status: "indexed",
      vector: [0.1, 0.2, 0.3],
    });
  });

  test("embedding 生成失败时记录 failed 状态且不回滚资源主数据", async () => {
    const { service, repo } = createTestService(new MemoryResourceRepository(), {
      getActiveEmbeddingProfile: async () => EMBEDDING_PROFILE,
      generateEmbedding: async () => {
        throw new Error("provider quota exceeded");
      },
    });

    const saved = await service.saveResource({
      workspaceId: "workspace:demo",
      resourceType: "generic_note",
      title: "索引失败资料",
      summary: "embedding 失败不应影响资源主数据。",
      evidence: [],
      structuredPayload: {},
      quality: "user-confirmed",
    });
    const detail = await service.getResourceDetail({ resourceId: saved.resource.id });

    expect(repo.resources.has(saved.resource.id)).toBe(true);
    expect(saved.resource.embedding).toMatchObject({
      status: "failed",
      errorSummary: "provider quota exceeded",
    });
    expect(detail.resource.embedding).toEqual(saved.resource.embedding);
  });

  test("向量检索只使用同一 embedding profile 的 indexed 向量", async () => {
    let activeProfile = EMBEDDING_PROFILE;
    const { service } = createTestService(new MemoryResourceRepository(), {
      getActiveEmbeddingProfile: async () => activeProfile,
      generateEmbedding: async ({ profile }: { profile: ResourceEmbeddingProfile }) => (
        profile.model === EMBEDDING_PROFILE.model ? [1, 0, 0] : [0, 1, 0]
      ),
    });

    const first = await service.saveResource({
      workspaceId: "workspace:demo",
      resourceType: "generic_note",
      title: "small profile 资源",
      summary: "应出现在 small profile 检索中。",
      evidence: [],
      structuredPayload: {},
      quality: "user-confirmed",
    });
    activeProfile = ALTERNATE_EMBEDDING_PROFILE;
    await service.saveResource({
      workspaceId: "workspace:demo",
      resourceType: "generic_note",
      title: "large profile 资源",
      summary: "不能混入 small profile 检索。",
      evidence: [],
      structuredPayload: {},
      quality: "user-confirmed",
    });

    const result = await service.searchResourceEmbeddings({
      workspaceId: "workspace:demo",
      profile: EMBEDDING_PROFILE,
      vector: [1, 0, 0],
      limit: 10,
    });

    expect(result.matches.map((match) => match.resourceId)).toEqual([first.resource.id]);
    expect(result.matches.every((match) => match.profileKey === createEmbeddingProfileKey(EMBEDDING_PROFILE))).toBe(true);
  });

  test("profile 变更后旧 embedding 标记 stale，资源级 retry 在当前 profile 下进入 pending", async () => {
    let activeProfile = EMBEDDING_PROFILE;
    const repo = new MemoryResourceRepository();
    const { service } = createTestService(repo, {
      getActiveEmbeddingProfile: async () => activeProfile,
      saveActiveEmbeddingProfile: async (_workspaceId: string, profile: ResourceEmbeddingProfile) => {
        activeProfile = profile;
      },
      generateEmbedding: async () => [1, 0, 0],
    });

    const saved = await service.saveResource({
      workspaceId: "workspace:demo",
      resourceType: "generic_note",
      title: "需要重算的资料",
      summary: "profile 变更后旧向量应 stale。",
      evidence: [],
      structuredPayload: {},
      quality: "user-confirmed",
    });

    const changed = await service.updateEmbeddingProfile({
      workspaceId: "workspace:demo",
      profile: ALTERNATE_EMBEDDING_PROFILE,
    });
    const retry = await service.retryResourceEmbedding({ resourceId: saved.resource.id });
    const rows = [...repo.embeddings.values()];

    expect(changed.staleCount).toBe(1);
    expect(rows.find((row) => row.profile_key === createEmbeddingProfileKey(EMBEDDING_PROFILE))?.status).toBe("stale");
    expect(retry.embedding).toMatchObject({
      status: "pending",
      profileKey: createEmbeddingProfileKey(ALTERNATE_EMBEDDING_PROFILE),
    });
    expect(rows.find((row) => row.profile_key === createEmbeddingProfileKey(ALTERNATE_EMBEDDING_PROFILE))?.status).toBe("pending");
  });

  test("资源级 retry 会把 failed 索引状态重新置为 pending", async () => {
    const repo = new MemoryResourceRepository();
    const { service } = createTestService(repo, {
      getActiveEmbeddingProfile: async () => EMBEDDING_PROFILE,
      generateEmbedding: async () => {
        throw new Error("temporary outage");
      },
    });
    const saved = await service.saveResource({
      workspaceId: "workspace:demo",
      resourceType: "generic_note",
      title: "失败后重试资料",
      summary: "retry 应清理 failed 错误状态。",
      evidence: [],
      structuredPayload: {},
      quality: "user-confirmed",
    });

    const retry = await service.retryResourceEmbedding({ resourceId: saved.resource.id });
    const row = [...repo.embeddings.values()][0];

    expect(saved.resource.embedding.status).toBe("failed");
    expect(retry.embedding).toMatchObject({
      status: "pending",
      errorSummary: undefined,
    });
    expect(row).toMatchObject({
      status: "pending",
      error_summary: undefined,
      vector: undefined,
    });
  });

  test("可创建并读取 open research session", async () => {
    const { service, canRead, canWrite } = createTestService();

    const created = await service.createResearchSession({
      workspaceId: "workspace:demo",
      query: "查找相似案例",
      context: { selectedRow: { id: "case:1", title: "合同解除争议" } },
      resourceType: "generic_note",
      originatingRunId: "run-1",
    });

    const fetched = await service.getResearchSession({ sessionId: created.session.id });

    expect(fetched.session).toMatchObject({
      id: "research_session:s1",
      workspaceId: "workspace:demo",
      query: "查找相似案例",
      context: { selectedRow: { id: "case:1", title: "合同解除争议" } },
      resourceType: "generic_note",
      status: "open",
      resourceIds: [],
      originatingRunId: "run-1",
      createdBy: "app_user:u1",
      createdAt: "2026-05-11T08:00:00.000Z",
      updatedAt: "2026-05-11T08:00:00.000Z",
    });
    expect(canWrite).toEqual(["workspace:demo"]);
    expect(canRead).toEqual(["workspace:demo"]);
  });

  test("保存到 research session 的资源会被关联并可完成会话", async () => {
    const { service } = createTestService();

    const createdSession = await service.createResearchSession({
      workspaceId: "workspace:demo",
      query: "查找相似案例",
      resourceType: "generic_note",
    });

    const saved = await service.saveResource({
      workspaceId: "workspace:demo",
      researchSessionId: createdSession.session.id,
      resourceType: "generic_note",
      title: "案例 A",
      summary: "确认后的案例摘要",
      evidence: [
        {
          text: "法院认为合同解除通知有效。",
          capturedAt: "2026-05-11T07:58:00.000Z",
          order: 0,
        },
      ],
      structuredPayload: {},
      quality: "user-confirmed",
    });

    const detail = await service.getResourceDetail({ resourceId: saved.resource.id });
    const completed = await service.completeResearchSession({ sessionId: createdSession.session.id });

    expect(detail.session).toEqual({
      id: createdSession.session.id,
      status: "open",
      query: "查找相似案例",
      resourceIds: [saved.resource.id],
    });
    expect(completed.session).toMatchObject({
      id: createdSession.session.id,
      status: "completed",
      resourceIds: [saved.resource.id],
      completedAt: "2026-05-11T08:00:00.000Z",
    });
  });

  test("可取消 open research session", async () => {
    const { service } = createTestService();
    const created = await service.createResearchSession({
      workspaceId: "workspace:demo",
      query: "查找相似案例",
      resourceType: "generic_note",
    });

    const cancelled = await service.cancelResearchSession({ sessionId: created.session.id });

    expect(cancelled.session).toMatchObject({
      id: created.session.id,
      status: "cancelled",
      cancelledAt: "2026-05-11T08:00:00.000Z",
    });
  });

  test("resource type registry 拒绝未知类型和未声明 payload", async () => {
    const { service } = createTestService();

    await expect(service.saveResource({
      workspaceId: "workspace:demo",
      resourceType: "unknown_type",
      title: "未注册资源",
      summary: "不应写入",
      evidence: [],
      structuredPayload: { anything: true },
      quality: "user-confirmed",
    })).rejects.toBeInstanceOf(ServiceError);

    await expect(service.saveResource({
      workspaceId: "workspace:demo",
      resourceType: "generic_note",
      title: "普通笔记",
      summary: "不应携带任意 payload",
      evidence: [],
      structuredPayload: { legalCaseId: "x" },
      quality: "user-confirmed",
    })).rejects.toBeInstanceOf(ServiceError);
  });

  test("重复资源不会被阻止且 duplicate hash 保持稳定", async () => {
    const { service } = createTestService();
    const input = {
      workspaceId: "workspace:demo",
      resourceType: "generic_note",
      title: "同一份资料",
      summary: "同一段摘要",
      sourceUrl: "https://example.com/a",
      sourceTitle: "Example",
      evidence: [
        {
          text: "同一段证据",
          sourceUrl: "https://example.com/a",
          sourceTitle: "Example",
          capturedAt: "2026-05-11T07:58:00.000Z",
          order: 0,
        },
      ],
      tags: ["duplicate"],
      structuredPayload: {},
      quality: "user-confirmed" as const,
    };

    const first = await service.saveResource(input);
    const second = await service.saveResource(input);

    expect(first.resource.id).not.toBe(second.resource.id);
    expect(first.resource.duplicateHashes).toEqual(second.resource.duplicateHashes);
  });

  test("读取详情时按资源所属 workspace 做隔离校验", async () => {
    const repo = new MemoryResourceRepository();
    const { service: writer } = createTestService(repo);
    const { service: reader } = createRejectingReadService(repo);
    const saved = await writer.saveResource({
      workspaceId: "workspace:private",
      resourceType: "generic_note",
      title: "跨空间资源",
      summary: "不应被无权用户读取",
      evidence: [],
      structuredPayload: {},
      quality: "user-confirmed",
    });

    await expect(reader.getResourceDetail({ resourceId: saved.resource.id }))
      .rejects.toBeInstanceOf(ServiceError);
  });
});
