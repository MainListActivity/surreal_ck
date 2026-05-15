import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import type { CapabilityKey } from "./capabilities";
import {
  createResourceService,
  type ResourceEmbeddingProfile,
  type ResourceEmbeddingRow,
  type ResourceRepository,
  type ResourceRow,
  type ResearchSessionRow,
} from "./resources";

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

  async updateResearchSession(
    sessionId: string,
    patch: Partial<Omit<ResearchSessionRow, "id">>,
  ): Promise<ResearchSessionRow | null> {
    const current = this.sessions.get(sessionId);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.sessions.set(sessionId, next);
    return next;
  }

  async linkResourceToResearchSession(resourceId: string, sessionId: string): Promise<void> {
    this.resourceSessionLinks.set(resourceId, sessionId);
  }

  async findResearchSessionIdByResource(resourceId: string): Promise<string | null> {
    return this.resourceSessionLinks.get(resourceId) ?? null;
  }
}

const EMBEDDING_PROFILE: ResourceEmbeddingProfile = {
  provider: "openai",
  model: "text-embedding-3-small",
  dimensions: 3,
  version: "2026-05-11",
};

function createTestService(repo = new MemoryResourceRepository()) {
  const canPerform: Array<{ capability: CapabilityKey; workspaceId?: string }> = [];
  const service = createResourceService({
    repository: repo,
    assertCanReadWorkspace: async () => undefined,
    assertCanPerformWrite: async (capability, workspaceId) => {
      canPerform.push({ capability, workspaceId });
    },
    getCurrentUserRecordId: async () => new RecordId("app_user", "u1"),
    getActiveEmbeddingProfile: async () => EMBEDDING_PROFILE,
    now: () => new Date("2026-05-11T08:00:00.000Z"),
  });
  return { service, repo, canPerform };
}

describe("resources facade", () => {
  test("发布 research resource 会组合共享资源、私有 session 关联和 pending embedding", async () => {
    const { service, repo, canPerform } = createTestService();
    const session = await service.createResearchSession({
      workspaceId: "workspace:demo",
      query: "查找相似案例",
      resourceType: "generic_note",
    });

    const saved = await service.saveResearchResource({
      sessionId: session.session.id,
      title: "案例 A",
      summary: "确认后的案例摘要",
      evidence: [],
      structuredPayload: {},
      quality: "user-confirmed",
    });
    const detail = await service.getResourceDetail({ resourceId: saved.resource.id });

    expect(saved.resource.embedding.status).toBe("pending");
    expect(detail.session?.id).toBe(session.session.id);
    expect(repo.resources.get(saved.resource.id)?.research_session).toBeUndefined();
    expect(canPerform).toEqual([
      { capability: "write_research_session", workspaceId: "workspace:demo" },
      { capability: "publish_shared_resource", workspaceId: "workspace:demo" },
      { capability: "write_research_session", workspaceId: "workspace:demo" },
      { capability: "advance_shared_embedding", workspaceId: "workspace:demo" },
    ]);
  });
});
