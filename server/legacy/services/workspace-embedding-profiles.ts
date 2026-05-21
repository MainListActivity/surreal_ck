import { createHash } from "node:crypto";
import { DateTime, RecordId, StringRecordId } from "surrealdb";
import { getLocalDb } from "../db/index";
import { omitNullishSurrealFields } from "../db/surreal-values";
import { assertCanReadWorkspace, assertCanPerformSharedWrite } from "./context";
import type { CapabilityKey } from "./capabilities";
import { ServiceError } from "./errors";

type RecordRef = RecordId | StringRecordId | string;

export type ResourceEmbeddingProvider = "openai" | "anthropic" | "google" | "custom" | string;
export type ResourceEmbeddingApiFormat = "openai-compatible" | "openai-responses" | "anthropic" | string;

export type ResourceEmbeddingProfile = {
  provider: ResourceEmbeddingProvider;
  model: string;
  dimensions: number;
  version: string;
  baseUrl?: string;
  apiFormat?: ResourceEmbeddingApiFormat;
};

export type WorkspaceEmbeddingProfileRow = {
  id: RecordRef;
  workspace: RecordRef;
  provider: string;
  model: string;
  dimensions: number;
  version: string;
  base_url?: string;
  api_format?: string;
  created_at: Date | string;
  updated_at: Date | string;
};

export type WorkspaceEmbeddingProfileDTO = {
  profileKey: string;
  provider: string;
  model: string;
  dimensions: number;
  version: string;
  baseUrl?: string;
  apiFormat?: string;
  updatedAt?: string;
};

export type GetWorkspaceEmbeddingProfileRequest = {
  workspaceId: string;
};

export type GetWorkspaceEmbeddingProfileResponse = {
  profile: WorkspaceEmbeddingProfileDTO | null;
};

export type UpdateWorkspaceEmbeddingProfileRequest = {
  workspaceId: string;
  profile: ResourceEmbeddingProfile;
};

export type UpdateWorkspaceEmbeddingProfileResponse = {
  profile: WorkspaceEmbeddingProfileDTO;
};

export type WorkspaceEmbeddingProfileRepository = {
  findByWorkspace(workspaceId: string): Promise<WorkspaceEmbeddingProfileRow | null>;
  saveForWorkspace(
    workspaceId: string,
    profile: ResourceEmbeddingProfile,
    timestamp: Date,
  ): Promise<WorkspaceEmbeddingProfileRow>;
};

export type WorkspaceEmbeddingProfileServiceDeps = {
  repository: WorkspaceEmbeddingProfileRepository;
  assertCanReadWorkspace(workspaceId: string): Promise<void>;
  assertCanPerformWrite(capability: CapabilityKey, workspaceId?: string): Promise<void>;
  now?: () => Date;
};

export function createEmbeddingProfileKey(profile: Pick<
  ResourceEmbeddingProfile,
  "provider" | "model" | "dimensions" | "version"
>): string {
  const provider = encodeURIComponent(profile.provider.trim().toLowerCase());
  const model = encodeURIComponent(profile.model.trim());
  const version = encodeURIComponent(profile.version.trim());
  return `provider=${provider}|model=${model}|dimensions=${profile.dimensions}|version=${version}`;
}

export function createWorkspaceEmbeddingProfileService(deps: WorkspaceEmbeddingProfileServiceDeps) {
  const now = deps.now ?? (() => new Date());

  return {
    async getProfile(
      req: GetWorkspaceEmbeddingProfileRequest,
    ): Promise<GetWorkspaceEmbeddingProfileResponse> {
      await deps.assertCanReadWorkspace(req.workspaceId);
      const row = await deps.repository.findByWorkspace(req.workspaceId);
      return { profile: row ? workspaceEmbeddingProfileRowToDTO(row) : null };
    },

    async updateProfile(
      req: UpdateWorkspaceEmbeddingProfileRequest,
    ): Promise<UpdateWorkspaceEmbeddingProfileResponse> {
      await deps.assertCanPerformWrite("advance_shared_embedding", req.workspaceId);
      const profile = normalizeEmbeddingProfile(req.profile);
      const row = await deps.repository.saveForWorkspace(req.workspaceId, profile, now());
      return { profile: workspaceEmbeddingProfileRowToDTO(row) };
    },
  };
}

export class SurrealWorkspaceEmbeddingProfileRepository implements WorkspaceEmbeddingProfileRepository {
  constructor(private readonly db = getLocalDb()) {}

  async findByWorkspace(workspaceId: string): Promise<WorkspaceEmbeddingProfileRow | null> {
    const rows = await this.db.query<[WorkspaceEmbeddingProfileRow[]]>(
      `SELECT * FROM workspace_embedding_profile WHERE workspace = $workspace LIMIT 1`,
      { workspace: new StringRecordId(workspaceId) },
    );
    return rows[0]?.[0] ?? null;
  }

  async saveForWorkspace(
    workspaceId: string,
    profile: ResourceEmbeddingProfile,
    timestamp: Date,
  ): Promise<WorkspaceEmbeddingProfileRow> {
    const rows = await this.db.query<[WorkspaceEmbeddingProfileRow[]]>(
      `UPSERT $id MERGE $content RETURN AFTER`,
      {
        id: new RecordId("workspace_embedding_profile", stableWorkspaceEmbeddingProfileId(workspaceId)),
        content: omitNullishSurrealFields({
          workspace: new StringRecordId(workspaceId),
          provider: profile.provider,
          model: profile.model,
          dimensions: profile.dimensions,
          version: profile.version,
          base_url: profile.baseUrl,
          api_format: profile.apiFormat,
          updated_at: toDateTime(timestamp),
        }),
      },
    );
    return requireRow(rows[0], "工作区 embedding profile 写入后读取失败");
  }
}

export function createDefaultWorkspaceEmbeddingProfileService() {
  return createWorkspaceEmbeddingProfileService({
    repository: new SurrealWorkspaceEmbeddingProfileRepository(),
    assertCanReadWorkspace,
    assertCanPerformWrite: assertCanPerformSharedWrite,
  });
}

export function getWorkspaceEmbeddingProfile(
  req: GetWorkspaceEmbeddingProfileRequest,
): Promise<GetWorkspaceEmbeddingProfileResponse> {
  return createDefaultWorkspaceEmbeddingProfileService().getProfile(req);
}

export function updateWorkspaceEmbeddingProfile(
  req: UpdateWorkspaceEmbeddingProfileRequest,
): Promise<UpdateWorkspaceEmbeddingProfileResponse> {
  return createDefaultWorkspaceEmbeddingProfileService().updateProfile(req);
}

export function workspaceEmbeddingProfileRowToProfile(
  row: WorkspaceEmbeddingProfileRow,
): ResourceEmbeddingProfile {
  return {
    provider: row.provider,
    model: row.model,
    dimensions: row.dimensions,
    version: row.version,
    baseUrl: row.base_url,
    apiFormat: row.api_format,
  };
}

export function workspaceEmbeddingProfileRowToDTO(
  row: WorkspaceEmbeddingProfileRow,
): WorkspaceEmbeddingProfileDTO {
  const profile = workspaceEmbeddingProfileRowToProfile(row);
  return {
    profileKey: createEmbeddingProfileKey(profile),
    provider: row.provider,
    model: row.model,
    dimensions: row.dimensions,
    version: row.version,
    baseUrl: row.base_url,
    apiFormat: row.api_format,
    updatedAt: row.updated_at ? toIso(row.updated_at) : undefined,
  };
}

export function normalizeEmbeddingProfile(profile: ResourceEmbeddingProfile): ResourceEmbeddingProfile {
  const provider = profile.provider.trim();
  const model = profile.model.trim();
  const version = profile.version.trim();
  const dimensions = Math.floor(profile.dimensions);
  const baseUrl = profile.baseUrl?.trim() || undefined;
  const apiFormat = profile.apiFormat?.trim() || undefined;

  if (!provider) throw new ServiceError("VALIDATION_ERROR", "embedding provider 不能为空");
  if (!model) throw new ServiceError("VALIDATION_ERROR", "embedding model 不能为空");
  if (!Number.isFinite(dimensions) || dimensions < 1) {
    throw new ServiceError("VALIDATION_ERROR", "embedding dimensions 必须是正整数");
  }
  if (!version) throw new ServiceError("VALIDATION_ERROR", "embedding profile version 不能为空");

  return {
    provider,
    model,
    dimensions,
    version,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiFormat ? { apiFormat } : {}),
  };
}

function stableWorkspaceEmbeddingProfileId(workspaceId: string): string {
  return createHash("sha256").update(workspaceId).digest("hex");
}

function requireRow<T>(rows: T[] | undefined, message: string): T {
  const row = rows?.[0];
  if (!row) throw new ServiceError("INTERNAL_ERROR", message);
  return row;
}

function toDateTime(value: Date | DateTime | string): DateTime {
  if (value instanceof DateTime) return value;
  return new DateTime(value instanceof Date ? value : new Date(value));
}

function toIso(value: Date | DateTime | string): string {
  if (value instanceof DateTime) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}
