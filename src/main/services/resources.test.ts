import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import {
  createEmbeddingProfileKey,
  createResourceService,
  listResourceTypeDefinitions,
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
  readonly resourceSessionLinks = new Map<string, string>();

  async createResource(input: Omit<ResourceRow, "id" | "research_session">): Promise<ResourceRow> {
    const row: ResourceRow = { id: new RecordId("resource_item", `r${++this.resourceSeq}`), ...input };
    this.resources.set(String(row.id), row);
    return row;
  }

  async linkResourceToResearchSession(resourceId: string, sessionId: string): Promise<void> {
    this.resourceSessionLinks.set(resourceId, sessionId);
  }

  async findResearchSessionIdByResource(resourceId: string): Promise<string | null> {
    return this.resourceSessionLinks.get(resourceId) ?? null;
  }

  async findResourceById(resourceId: string): Promise<ResourceRow | null> {
    return this.resources.get(resourceId) ?? null;
  }

  async listResourcesByWorkspace(workspaceId: string): Promise<ResourceRow[]> {
    return [...this.resources.values()].filter((row) => String(row.workspace) === workspaceId);
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

  test("shared resource_item 载荷不再携带 research_session 引用", async () => {
    const { service, repo } = createTestService();

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
      summary: "摘要",
      evidence: [],
      structuredPayload: {},
      quality: "user-confirmed",
    });

    const sharedRow = repo.resources.get(saved.resource.id);
    expect(sharedRow?.research_session).toBeUndefined();
    // 本地伴随关联仍然可读
    const detail = await service.getResourceDetail({ resourceId: saved.resource.id });
    expect(detail.session?.id).toBe(createdSession.session.id);
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

  test("saveResearchResource 专用入口可在一个 open session 保存多个资源且不等待 indexed", async () => {
    const { service } = createTestService(new MemoryResourceRepository(), {
      getActiveEmbeddingProfile: async () => EMBEDDING_PROFILE,
    });
    const createdSession = await service.createResearchSession({
      workspaceId: "workspace:demo",
      query: "查找相似案例",
      resourceType: "generic_note",
    });

    const first = await service.saveResearchResource({
      sessionId: createdSession.session.id,
      title: "案例 A",
      summary: "A 摘要",
      evidence: [],
      structuredPayload: {},
      quality: "user-confirmed",
    });
    const second = await service.saveResearchResource({
      sessionId: createdSession.session.id,
      title: "案例 B",
      summary: "B 摘要",
      evidence: [],
      structuredPayload: {},
      quality: "user-confirmed",
    });
    const completed = await service.completeResearchSession({ sessionId: createdSession.session.id });

    expect(first.resource.embedding.status).toBe("pending");
    expect(second.resource.embedding.status).toBe("pending");
    expect(completed.session.resourceIds).toEqual([first.resource.id, second.resource.id]);
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

  test("web_article 要求来源、来源标题和至少一段证据，但允许网页元数据缺失", async () => {
    const { service } = createTestService();

    const saved = await service.saveResource({
      workspaceId: "workspace:demo",
      resourceType: "web_article",
      title: "网页资料",
      summary: "网页资料摘要",
      sourceUrl: "https://example.com/article",
      sourceTitle: "Example Article",
      evidence: [
        {
          text: "网页正文中的关键证据。",
          sourceUrl: "https://example.com/article",
          sourceTitle: "Example Article",
          capturedAt: "2026-05-11T07:59:00.000Z",
          order: 0,
        },
      ],
      structuredPayload: {},
      quality: "user-confirmed",
    });

    expect(saved.resource).toMatchObject({
      resourceType: "web_article",
      sourceUrl: "https://example.com/article",
      sourceTitle: "Example Article",
      structuredPayload: {},
    });

    await expect(service.saveResource({
      workspaceId: "workspace:demo",
      resourceType: "web_article",
      title: "缺少来源",
      summary: "网页资料摘要",
      sourceTitle: "Example Article",
      evidence: [
        {
          text: "网页正文中的关键证据。",
          capturedAt: "2026-05-11T07:59:00.000Z",
          order: 0,
        },
      ],
      structuredPayload: {},
      quality: "user-confirmed",
    })).rejects.toThrow("web_article 必须包含有效 sourceUrl");

    await expect(service.saveResource({
      workspaceId: "workspace:demo",
      resourceType: "web_article",
      title: "缺少证据",
      summary: "网页资料摘要",
      sourceUrl: "https://example.com/article",
      sourceTitle: "Example Article",
      evidence: [],
      structuredPayload: {},
      quality: "user-confirmed",
    })).rejects.toThrow("web_article 至少需要一段证据");
  });

  test("web_article 接受 author、publishedAt、siteName 且拒绝未声明 payload 字段", async () => {
    const { service } = createTestService();

    const saved = await service.saveResource({
      workspaceId: "workspace:demo",
      resourceType: "web_article",
      title: "带元数据网页",
      summary: "网页资料摘要",
      sourceUrl: "https://example.com/article",
      sourceTitle: "Example Article",
      evidence: [
        {
          text: "网页正文中的关键证据。",
          sourceUrl: "https://example.com/article",
          sourceTitle: "Example Article",
          capturedAt: "2026-05-11T07:59:00.000Z",
          order: 0,
        },
      ],
      structuredPayload: {
        author: "Researcher",
        publishedAt: "2026-05-01T00:00:00.000Z",
        siteName: "Example",
      },
      quality: "user-confirmed",
    });

    expect(saved.resource.structuredPayload).toEqual({
      author: "Researcher",
      publishedAt: "2026-05-01T00:00:00.000Z",
      siteName: "Example",
    });

    await expect(service.saveResource({
      workspaceId: "workspace:demo",
      resourceType: "web_article",
      title: "非法 payload",
      summary: "网页资料摘要",
      sourceUrl: "https://example.com/article",
      sourceTitle: "Example Article",
      evidence: [
        {
          text: "网页正文中的关键证据。",
          sourceUrl: "https://example.com/article",
          sourceTitle: "Example Article",
          capturedAt: "2026-05-11T07:59:00.000Z",
          order: 0,
        },
      ],
      structuredPayload: { legalCaseId: "reserved" },
      quality: "user-confirmed",
    })).rejects.toThrow("资源结构化 payload 不符合类型约束");
  });

  test("legal resource type 仅预留定义，不影响 V1 可保存类型", async () => {
    const { service } = createTestService();

    expect(listResourceTypeDefinitions()).toEqual([
      { type: "generic_note", status: "active" },
      { type: "web_article", status: "active" },
      { type: "legal_case", status: "reserved" },
      { type: "legal_article", status: "reserved" },
    ]);

    await expect(service.saveResource({
      workspaceId: "workspace:demo",
      resourceType: "legal_case",
      title: "预留法律案例",
      summary: "本 slice 不应允许保存。",
      evidence: [],
      structuredPayload: {},
      quality: "user-confirmed",
    })).rejects.toThrow("资源类型 legal_case 已预留但尚未启用");
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

  test("searchResources 用关键词 contains 检索标题、摘要、标签和证据，并在无 embedding 配置时标记 index-disabled", async () => {
    const { service } = createTestService();
    const first = await service.saveResource({
      workspaceId: "workspace:demo",
      resourceType: "generic_note",
      title: "相似案例检索策略",
      summary: "围绕合同解除争议整理裁判要旨。",
      evidence: [
        {
          text: "法院认为解除通知到达后产生效力。",
          capturedAt: "2026-05-11T07:58:00.000Z",
          order: 0,
        },
      ],
      tags: ["合同解除"],
      structuredPayload: {},
      quality: "user-confirmed",
    });
    await service.saveResource({
      workspaceId: "workspace:demo",
      resourceType: "generic_note",
      title: "无关资料",
      summary: "讲述仪表盘布局。",
      evidence: [],
      structuredPayload: {},
      quality: "user-confirmed",
    });

    const result = await service.searchResources({
      workspaceId: "workspace:demo",
      query: "合同解除 裁判要旨",
      resourceType: "generic_note",
      limit: 5,
      answerThreshold: 0.2,
      candidateThreshold: 0.05,
    });

    expect(result.status).toBe("hit");
    expect(result.indexStatus).toBe("index-disabled");
    expect(result.results.map((item) => item.resource.id)).toEqual([first.resource.id]);
    expect(result.results[0]?.keywordScore).toBeGreaterThan(0);
    expect(result.results[0]?.vectorScore).toBe(0);
  });

  test("searchResources 用当前 profile 的服务层 cosine 向量分排序", async () => {
    const { service } = createTestService(new MemoryResourceRepository(), {
      getActiveEmbeddingProfile: async () => EMBEDDING_PROFILE,
      generateEmbedding: async ({ resource }: { resource: ResourceRow }) => (
        resource.title.includes("高相关") ? [1, 0, 0] : [0, 1, 0]
      ),
      generateSearchEmbedding: async () => [1, 0, 0],
    });
    const low = await service.saveResource({
      workspaceId: "workspace:demo",
      resourceType: "generic_note",
      title: "低相关资源",
      summary: "语义距离较远。",
      evidence: [],
      structuredPayload: {},
      quality: "user-confirmed",
    });
    const high = await service.saveResource({
      workspaceId: "workspace:demo",
      resourceType: "generic_note",
      title: "高相关资源",
      summary: "语义距离最近。",
      evidence: [],
      structuredPayload: {},
      quality: "user-confirmed",
    });

    const result = await service.searchResources({
      workspaceId: "workspace:demo",
      query: "完全不同的自然语言问题",
      resourceType: "generic_note",
      limit: 2,
      answerThreshold: 0.5,
      candidateThreshold: 0.1,
    });

    expect(result.status).toBe("hit");
    expect(result.indexStatus).toBe("ready");
    expect(result.results.map((item) => item.resource.id)).toEqual([high.resource.id, low.resource.id]);
    expect(result.results[0]?.vectorScore).toBeGreaterThan(result.results[1]?.vectorScore ?? 0);
    expect(result.results[0]?.keywordScore).toBe(0);
  });

  test("searchResources 支持 context、filters、limit，并按阈值返回 candidates 或 miss", async () => {
    let currentTime = new Date("2026-01-01T08:00:00.000Z");
    const { service } = createTestService(new MemoryResourceRepository(), {
      now: () => currentTime,
    });
    await service.saveResource({
      workspaceId: "workspace:demo",
      resourceType: "generic_note",
      title: "早期资料",
      summary: "违约责任资料，但来源和日期不满足过滤。",
      sourceUrl: "https://old.example.com/a",
      evidence: [],
      tags: ["合同"],
      structuredPayload: {},
      quality: "user-confirmed",
    });
    currentTime = new Date("2026-05-11T08:00:00.000Z");
    const kept = await service.saveResource({
      workspaceId: "workspace:demo",
      resourceType: "generic_note",
      title: "合同违约责任检索",
      summary: "使用选中行上下文补足查询。",
      sourceUrl: "https://law.example.com/case",
      evidence: [],
      tags: ["合同", "案例"],
      structuredPayload: {},
      quality: "user-confirmed",
    });
    await service.saveResource({
      workspaceId: "workspace:demo",
      resourceType: "generic_note",
      title: "不同标签资料",
      summary: "违约责任但标签不满足过滤。",
      sourceUrl: "https://law.example.com/other",
      evidence: [],
      tags: ["行政"],
      structuredPayload: {},
      quality: "user-confirmed",
    });

    const candidates = await service.searchResources({
      workspaceId: "workspace:demo",
      query: "争议焦点",
      context: {
        selectedRow: {
          id: "case:1",
          label: "案件 A",
          visibleValues: { issue: "合同违约责任" },
        },
      },
      resourceType: "generic_note",
      filters: {
        tags: ["合同", "案例"],
        sourceDomain: "law.example.com",
        dateFrom: "2026-05-01T00:00:00.000Z",
      },
      limit: 1,
      answerThreshold: 0.95,
      candidateThreshold: 0.1,
    });
    const miss = await service.searchResources({
      workspaceId: "workspace:demo",
      query: "完全不存在的关键词",
      resourceType: "generic_note",
      candidateThreshold: 0.1,
    });

    expect(candidates.status).toBe("candidates");
    expect(candidates.results.map((item) => item.resource.id)).toEqual([kept.resource.id]);
    expect(candidates.queryText).toContain("合同违约责任");
    expect(miss.status).toBe("miss");
    expect(miss.results).toEqual([]);
  });

  test("searchResources 区分 pending 和 failed 索引不可用状态", async () => {
    const pending = createTestService(new MemoryResourceRepository(), {
      getActiveEmbeddingProfile: async () => EMBEDDING_PROFILE,
    });
    await pending.service.saveResource({
      workspaceId: "workspace:demo",
      resourceType: "generic_note",
      title: "待索引合同资源",
      summary: "已经保存但还没有向量。",
      evidence: [],
      structuredPayload: {},
      quality: "user-confirmed",
    });

    const failed = createTestService(new MemoryResourceRepository(), {
      getActiveEmbeddingProfile: async () => EMBEDDING_PROFILE,
      generateEmbedding: async () => {
        throw new Error("embedding offline");
      },
    });
    await failed.service.saveResource({
      workspaceId: "workspace:demo",
      resourceType: "generic_note",
      title: "索引失败合同资源",
      summary: "向量生成失败但资源存在。",
      evidence: [],
      structuredPayload: {},
      quality: "user-confirmed",
    });

    const pendingResult = await pending.service.searchResources({
      workspaceId: "workspace:demo",
      query: "合同",
      resourceType: "generic_note",
    });
    const failedResult = await failed.service.searchResources({
      workspaceId: "workspace:demo",
      query: "合同",
      resourceType: "generic_note",
    });

    expect(pendingResult.indexStatus).toBe("index-pending");
    expect(failedResult.indexStatus).toBe("index-error");
  });
});
