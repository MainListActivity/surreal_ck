import { createHash } from "node:crypto";
import { DateTime } from "surrealdb";
import type { CapabilityKey } from "./capabilities";
import type {
  ResourceEmbeddingDTO,
  ResourceEmbeddingRow,
  ResourceRow,
  ResourceSearchIndexStatus,
} from "./resources";
import {
  createEmbeddingProfileKey,
  type ResourceEmbeddingProfile,
} from "./workspace-embedding-profiles";

export type ResourceEmbeddingRepository = {
  listResourcesByWorkspace(workspaceId: string): Promise<ResourceRow[]>;
  upsertResourceEmbedding(input: Omit<ResourceEmbeddingRow, "id">): Promise<ResourceEmbeddingRow>;
  findResourceEmbeddingsByResource(resourceId: string): Promise<ResourceEmbeddingRow[]>;
  listIndexedResourceEmbeddings(workspaceId: string, profileKey: string): Promise<ResourceEmbeddingRow[]>;
  markResourceEmbeddingsStaleForWorkspace(
    workspaceId: string,
    activeProfileKey: string,
    updatedAt: Date,
  ): Promise<number>;
};

export type ResourceIndexerDeps = {
  repository: ResourceEmbeddingRepository;
  assertCanPerformWrite(capability: CapabilityKey, workspaceId?: string): Promise<void>;
  getActiveEmbeddingProfile?(workspaceId: string): Promise<ResourceEmbeddingProfile | null>;
  generateEmbedding?(input: {
    profile: ResourceEmbeddingProfile;
    resource: ResourceRow;
    text: string;
    embeddingTextHash: string;
  }): Promise<number[]>;
};

export type PrepareWorkspaceEmbeddingProfileChangeRequest = {
  repository: ResourceEmbeddingRepository;
  workspaceId: string;
  profile: ResourceEmbeddingProfile;
  timestamp: Date;
};

export type PrepareWorkspaceEmbeddingProfileChangeResponse = {
  staleCount: number;
  pendingCount: number;
};

export async function prepareWorkspaceEmbeddingProfileChange(
  req: PrepareWorkspaceEmbeddingProfileChangeRequest,
): Promise<PrepareWorkspaceEmbeddingProfileChangeResponse> {
  const profileKey = createEmbeddingProfileKey(req.profile);
  const staleCount = await req.repository.markResourceEmbeddingsStaleForWorkspace(
    req.workspaceId,
    profileKey,
    req.timestamp,
  );
  const rows = await req.repository.listResourcesByWorkspace(req.workspaceId);

  await Promise.all(rows.map((row) => upsertPendingResourceEmbedding({
    repository: req.repository,
    row,
    profile: req.profile,
    timestamp: req.timestamp,
  })));

  return { staleCount, pendingCount: rows.length };
}

export async function ensureInitialEmbeddingState(
  deps: ResourceIndexerDeps,
  row: ResourceRow,
  timestamp: Date,
): Promise<ResourceEmbeddingDTO> {
  const profile = await deps.getActiveEmbeddingProfile?.(String(row.workspace)) ?? null;
  if (!profile) return { status: "disabled" };

  const existing = await findEmbeddingForProfile(deps.repository, row, profile);
  if (existing) return embeddingRowToDTO(existing);

  await deps.assertCanPerformWrite("advance_shared_embedding", String(row.workspace));
  const embeddingRow = await upsertPendingResourceEmbedding({
    repository: deps.repository,
    row,
    profile,
    timestamp,
  });
  if (!deps.generateEmbedding) return embeddingRowToDTO(embeddingRow);

  try {
    const embeddingText = buildResourceEmbeddingText(row);
    const embeddingTextHash = stableHash(embeddingText);
    const vector = await deps.generateEmbedding({
      profile,
      resource: row,
      text: embeddingText,
      embeddingTextHash,
    });
    const indexedRow = await deps.repository.upsertResourceEmbedding({
      ...embeddingRow,
      vector,
      status: "indexed",
      error_summary: undefined,
      indexed_at: timestamp,
      updated_at: timestamp,
    });
    return embeddingRowToDTO(indexedRow);
  } catch (error) {
    const failedRow = await deps.repository.upsertResourceEmbedding({
      ...embeddingRow,
      status: "failed",
      error_summary: summarizeEmbeddingError(error),
      indexed_at: undefined,
      updated_at: timestamp,
    });
    return embeddingRowToDTO(failedRow);
  }
}

export async function resolveResourceEmbeddingState(
  deps: Pick<ResourceIndexerDeps, "repository" | "getActiveEmbeddingProfile">,
  row: ResourceRow,
): Promise<ResourceEmbeddingDTO> {
  const profile = await deps.getActiveEmbeddingProfile?.(String(row.workspace)) ?? null;
  if (!profile) return { status: "disabled" };

  const existing = await findEmbeddingForProfile(deps.repository, row, profile);
  if (existing) return embeddingRowToDTO(existing);
  return {
    status: "pending",
    ...embeddingProfileToDTOFields(profile),
  };
}

export async function retryResourceEmbeddingState(
  deps: Pick<ResourceIndexerDeps, "repository" | "getActiveEmbeddingProfile">,
  row: ResourceRow,
  timestamp: Date,
): Promise<ResourceEmbeddingDTO> {
  const profile = await deps.getActiveEmbeddingProfile?.(String(row.workspace)) ?? null;
  if (!profile) return { status: "disabled" };
  const embeddingRow = await upsertPendingResourceEmbedding({
    repository: deps.repository,
    row,
    profile,
    timestamp,
  });
  return embeddingRowToDTO(embeddingRow);
}

export async function indexResourceEmbedding(input: {
  repository: ResourceEmbeddingRepository;
  row: ResourceRow;
  profile: ResourceEmbeddingProfile;
  timestamp: Date;
  generateEmbedding(text: string): Promise<number[]>;
}): Promise<ResourceEmbeddingDTO> {
  const pendingRow = await upsertPendingResourceEmbedding({
    repository: input.repository,
    row: input.row,
    profile: input.profile,
    timestamp: input.timestamp,
  });

  try {
    const vector = await input.generateEmbedding(buildResourceEmbeddingText(input.row));
    const indexedAt = new Date();
    const indexedRow = await input.repository.upsertResourceEmbedding({
      ...pendingRow,
      vector,
      status: "indexed",
      error_summary: undefined,
      indexed_at: indexedAt,
      updated_at: indexedAt,
    });
    return embeddingRowToDTO(indexedRow);
  } catch (error) {
    const failedAt = new Date();
    const failedRow = await input.repository.upsertResourceEmbedding({
      ...pendingRow,
      vector: undefined,
      status: "failed",
      error_summary: summarizeEmbeddingError(error),
      indexed_at: undefined,
      updated_at: failedAt,
    });
    return embeddingRowToDTO(failedRow);
  }
}

export async function buildVectorScoreMap(
  deps: Pick<ResourceIndexerDeps, "repository" | "generateEmbedding"> & {
    generateSearchEmbedding?(input: {
      profile: ResourceEmbeddingProfile;
      text: string;
    }): Promise<number[]>;
  },
  input: {
    workspaceId: string;
    queryText: string;
    rows: ResourceRow[];
    profile: ResourceEmbeddingProfile | null;
  },
): Promise<{ indexStatus: ResourceSearchIndexStatus; scores: Map<string, number> }> {
  if (!input.profile) return { indexStatus: "index-disabled", scores: new Map() };
  if (!deps.generateSearchEmbedding) {
    return { indexStatus: await inferUnavailableIndexStatus(deps, input.rows, input.profile), scores: new Map() };
  }

  try {
    const queryVector = await deps.generateSearchEmbedding({
      profile: input.profile,
      text: input.queryText,
    });
    const profileKey = createEmbeddingProfileKey(input.profile);
    const embeddings = await deps.repository.listIndexedResourceEmbeddings(input.workspaceId, profileKey);
    const scores = new Map<string, number>();
    for (const embedding of embeddings) {
      if (!embedding.vector?.length) continue;
      scores.set(String(embedding.resource), cosineSimilarity(queryVector, embedding.vector));
    }
    return {
      indexStatus: scores.size > 0 ? "ready" : await inferUnavailableIndexStatus(deps, input.rows, input.profile),
      scores,
    };
  } catch {
    return { indexStatus: "index-error", scores: new Map() };
  }
}

export function embeddingProfileToRowFields(profile: ResourceEmbeddingProfile): Pick<
  ResourceEmbeddingRow,
  "profile_key" | "provider" | "model" | "dimensions" | "profile_version"
> {
  return {
    profile_key: createEmbeddingProfileKey(profile),
    provider: profile.provider,
    model: profile.model,
    dimensions: profile.dimensions,
    profile_version: profile.version,
  };
}

export function embeddingProfileToDTOFields(profile: ResourceEmbeddingProfile): Omit<ResourceEmbeddingDTO, "status"> {
  return {
    profileKey: createEmbeddingProfileKey(profile),
    provider: profile.provider,
    model: profile.model,
    dimensions: profile.dimensions,
    version: profile.version,
  };
}

export function embeddingRowToDTO(row: ResourceEmbeddingRow): ResourceEmbeddingDTO {
  return {
    status: row.status,
    profileKey: row.profile_key,
    provider: row.provider,
    model: row.model,
    dimensions: row.dimensions,
    version: row.profile_version,
    errorSummary: row.error_summary,
    indexedAt: row.indexed_at ? toIso(row.indexed_at) : undefined,
    updatedAt: toIso(row.updated_at),
  };
}

export async function findEmbeddingForProfile(
  repository: Pick<ResourceEmbeddingRepository, "findResourceEmbeddingsByResource">,
  row: ResourceRow,
  profile: ResourceEmbeddingProfile,
): Promise<ResourceEmbeddingRow | null> {
  const profileKey = createEmbeddingProfileKey(profile);
  const embeddings = await repository.findResourceEmbeddingsByResource(String(row.id));
  return embeddings.find((embedding) => embedding.profile_key === profileKey) ?? null;
}

export function buildResourceEmbeddingText(row: ResourceRow): string {
  return [
    row.title,
    row.summary,
    row.source_title,
    row.tags.join("\n"),
    ...row.evidence.map((item) => item.text),
  ].filter(Boolean).join("\n");
}

export function summarizeEmbeddingError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const trimmed = message.trim();
  return trimmed ? trimmed.slice(0, 500) : "embedding 生成失败";
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

async function upsertPendingResourceEmbedding(input: {
  repository: Pick<ResourceEmbeddingRepository, "upsertResourceEmbedding">;
  row: ResourceRow;
  profile: ResourceEmbeddingProfile;
  timestamp: Date;
}): Promise<ResourceEmbeddingRow> {
  const embeddingText = buildResourceEmbeddingText(input.row);
  return input.repository.upsertResourceEmbedding({
    workspace: input.row.workspace,
    resource: input.row.id,
    ...embeddingProfileToRowFields(input.profile),
    embedding_text_hash: stableHash(embeddingText),
    vector: undefined,
    status: "pending",
    error_summary: undefined,
    indexed_at: undefined,
    created_at: input.timestamp,
    updated_at: input.timestamp,
  });
}

async function inferUnavailableIndexStatus(
  deps: Pick<ResourceIndexerDeps, "repository">,
  rows: ResourceRow[],
  profile: ResourceEmbeddingProfile,
): Promise<ResourceSearchIndexStatus> {
  const embeddings = (await Promise.all(rows.map((row) => findEmbeddingForProfile(deps.repository, row, profile))))
    .filter((row): row is ResourceEmbeddingRow => Boolean(row));
  if (embeddings.some((row) => row.status === "failed")) return "index-error";
  return "index-pending";
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function toIso(value: Date | DateTime | string): string {
  if (value instanceof DateTime) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}
