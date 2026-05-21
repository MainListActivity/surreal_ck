import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import {
  createEmbeddingProfileKey,
  type ResourceEmbeddingProfile,
} from "./workspace-embedding-profiles";
import {
  prepareWorkspaceEmbeddingProfileChange,
  type ResourceEmbeddingRepository,
} from "./resource-indexing";
import type { ResourceEmbeddingRow, ResourceRow } from "./resources";

class MemoryResourceEmbeddingRepository implements ResourceEmbeddingRepository {
  readonly resources = new Map<string, ResourceRow>();
  readonly embeddings = new Map<string, ResourceEmbeddingRow>();

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
}

const OLD_PROFILE: ResourceEmbeddingProfile = {
  provider: "openai",
  model: "text-embedding-3-small",
  dimensions: 3,
  version: "2026-05-10",
};

const NEW_PROFILE: ResourceEmbeddingProfile = {
  provider: "openai",
  model: "text-embedding-3-large",
  dimensions: 3,
  version: "2026-05-11",
};

function resource(id: string, title: string): ResourceRow {
  return {
    id: new RecordId("resource_item", id),
    workspace: new RecordId("workspace", "demo"),
    resource_type: "generic_note",
    title,
    summary: `${title} 摘要`,
    evidence: [],
    tags: [],
    structured_payload: {},
    quality: "user-confirmed",
    content_hash: `${id}-content`,
    evidence_hash: `${id}-evidence`,
    source_hash: `${id}-source`,
    created_by: new RecordId("app_user", "u1"),
    created_at: new Date("2026-05-11T07:00:00.000Z"),
    updated_at: new Date("2026-05-11T07:00:00.000Z"),
  };
}

describe("resource indexing", () => {
  test("profile 变更会 stale 旧向量，并为工作区资源创建新 profile pending 状态", async () => {
    const repo = new MemoryResourceEmbeddingRepository();
    const first = resource("r1", "第一份资源");
    const second = resource("r2", "第二份资源");
    repo.resources.set(String(first.id), first);
    repo.resources.set(String(second.id), second);
    await repo.upsertResourceEmbedding({
      workspace: first.workspace,
      resource: first.id,
      profile_key: createEmbeddingProfileKey(OLD_PROFILE),
      provider: OLD_PROFILE.provider,
      model: OLD_PROFILE.model,
      dimensions: OLD_PROFILE.dimensions,
      profile_version: OLD_PROFILE.version,
      embedding_text_hash: "old-hash",
      vector: [1, 0, 0],
      status: "indexed",
      created_at: new Date("2026-05-11T07:30:00.000Z"),
      updated_at: new Date("2026-05-11T07:30:00.000Z"),
    });

    const result = await prepareWorkspaceEmbeddingProfileChange({
      repository: repo,
      workspaceId: "workspace:demo",
      profile: NEW_PROFILE,
      timestamp: new Date("2026-05-11T08:00:00.000Z"),
    });
    const newProfileKey = createEmbeddingProfileKey(NEW_PROFILE);
    const rows = [...repo.embeddings.values()];

    expect(result).toEqual({ staleCount: 1, pendingCount: 2 });
    expect(rows.find((row) => row.profile_key === createEmbeddingProfileKey(OLD_PROFILE))?.status).toBe("stale");
    expect(rows.filter((row) => row.profile_key === newProfileKey).map((row) => row.status)).toEqual([
      "pending",
      "pending",
    ]);
    expect(rows.filter((row) => row.profile_key === newProfileKey).every((row) => !row.vector)).toBe(true);
    expect(rows.filter((row) => row.profile_key === newProfileKey).every((row) => row.embedding_text_hash.length === 64))
      .toBe(true);
  });
});
