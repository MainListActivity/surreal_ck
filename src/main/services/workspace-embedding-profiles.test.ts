import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import type { CapabilityKey } from "./capabilities";
import {
  createEmbeddingProfileKey,
  createWorkspaceEmbeddingProfileService,
  type ResourceEmbeddingProfile,
  type WorkspaceEmbeddingProfileRepository,
  type WorkspaceEmbeddingProfileRow,
} from "./workspace-embedding-profiles";

class MemoryWorkspaceEmbeddingProfileRepository implements WorkspaceEmbeddingProfileRepository {
  readonly rows = new Map<string, WorkspaceEmbeddingProfileRow>();

  async findByWorkspace(workspaceId: string): Promise<WorkspaceEmbeddingProfileRow | null> {
    return this.rows.get(workspaceId) ?? null;
  }

  async saveForWorkspace(
    workspaceId: string,
    profile: ResourceEmbeddingProfile,
    timestamp: Date,
  ): Promise<WorkspaceEmbeddingProfileRow> {
    const row: WorkspaceEmbeddingProfileRow = {
      id: new RecordId("workspace_embedding_profile", workspaceId.replace(/[^a-zA-Z0-9_:-]/g, "_")),
      workspace: new RecordId("workspace", workspaceId.split(":")[1] ?? workspaceId),
      provider: profile.provider,
      model: profile.model,
      dimensions: profile.dimensions,
      version: profile.version,
      base_url: profile.baseUrl,
      api_format: profile.apiFormat,
      created_at: this.rows.get(workspaceId)?.created_at ?? timestamp,
      updated_at: timestamp,
    };
    this.rows.set(workspaceId, row);
    return row;
  }
}

describe("workspace embedding profile", () => {
  test("canonical profile 保存到工作区专用 Module，且不承载私有 credential", async () => {
    const repo = new MemoryWorkspaceEmbeddingProfileRepository();
    const canPerform: Array<{ capability: CapabilityKey; workspaceId?: string }> = [];
    const service = createWorkspaceEmbeddingProfileService({
      repository: repo,
      assertCanReadWorkspace: async () => undefined,
      assertCanPerformWrite: async (capability, workspaceId) => {
        canPerform.push({ capability, workspaceId });
      },
      now: () => new Date("2026-05-11T08:00:00.000Z"),
    });

    const profile = await service.updateProfile({
      workspaceId: "workspace:demo",
      profile: {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
        version: "2026-05-11",
        baseUrl: "https://api.openai.com/v1",
        apiFormat: "openai-compatible",
      },
    });
    const fetched = await service.getProfile({ workspaceId: "workspace:demo" });

    expect(profile).toEqual({
      profile: {
        profileKey: createEmbeddingProfileKey({
          provider: "openai",
          model: "text-embedding-3-small",
          dimensions: 1536,
          version: "2026-05-11",
        }),
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
        version: "2026-05-11",
        baseUrl: "https://api.openai.com/v1",
        apiFormat: "openai-compatible",
        updatedAt: "2026-05-11T08:00:00.000Z",
      },
    });
    expect(fetched).toEqual(profile);
    expect("apiKey" in profile.profile).toBe(false);
    expect(canPerform).toEqual([
      { capability: "advance_shared_embedding", workspaceId: "workspace:demo" },
    ]);
  });
});
