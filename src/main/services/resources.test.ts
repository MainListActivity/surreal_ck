import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import {
  createResourceService,
  type ResourceRepository,
  type ResourceRow,
  type ResearchSessionRow,
} from "./resources";
import { ServiceError } from "./errors";

class MemoryResourceRepository implements ResourceRepository {
  private resourceSeq = 0;
  private sessionSeq = 0;
  readonly resources = new Map<string, ResourceRow>();
  readonly sessions = new Map<string, ResearchSessionRow>();

  async createResource(input: Omit<ResourceRow, "id">): Promise<ResourceRow> {
    const row = { id: new RecordId("resource_item", `r${++this.resourceSeq}`), ...input };
    this.resources.set(String(row.id), row);
    return row;
  }

  async findResourceById(resourceId: string): Promise<ResourceRow | null> {
    return this.resources.get(resourceId) ?? null;
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

function createTestService(repo = new MemoryResourceRepository()) {
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

describe("资源主数据闭环", () => {
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
