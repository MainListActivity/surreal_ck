import { createHash } from "node:crypto";
import { DateTime, RecordId, StringRecordId, Table } from "surrealdb";
import { getLocalDb } from "../db/index";
import { omitNullishSurrealFields } from "../db/surreal-values";
import { assertCanReadWorkspace, assertCanPerformSharedWrite, getCurrentUserRecordId } from "./context";
import type { CapabilityKey } from "./capabilities";
import { generateEmbeddingVector } from "./embedding-client";
import { ServiceError } from "./errors";
import { getEmbeddingSettings, type AiApiFormat, type AiProvider, type EmbeddingSettings } from "./settings";
import {
  buildVectorScoreMap,
  embeddingProfileToDTOFields,
  ensureInitialEmbeddingState,
  indexResourceEmbedding,
  prepareWorkspaceEmbeddingProfileChange,
  resolveResourceEmbeddingState,
  retryResourceEmbeddingState,
} from "./resource-indexing";
import {
  createEmbeddingProfileKey,
  normalizeEmbeddingProfile,
  SurrealWorkspaceEmbeddingProfileRepository,
  workspaceEmbeddingProfileRowToProfile,
  type ResourceEmbeddingProfile,
} from "./workspace-embedding-profiles";
import {
  linkPublishedResourceToOpenSession,
  loadOpenResearchSessionForResource,
  researchSessionSummary,
} from "./research-sessions";
import {
  buildResourceSearchText,
  rankResourceSearchRows,
} from "./resource-search";
import {
  prepareSharedResourceDraft,
  validateResourceType,
} from "./shared-resource-library";

export { createEmbeddingProfileKey } from "./workspace-embedding-profiles";
export type { ResourceEmbeddingProfile } from "./workspace-embedding-profiles";
export { listResourceTypeDefinitions } from "./shared-resource-library";
export type { ResourceTypeDefinition } from "./shared-resource-library";

type RecordRef = RecordId | StringRecordId | string;

export type ResourceQuality = "user-confirmed" | "ai-draft" | "imported" | "deprecated";

export type ResourceEvidence = {
  text: string;
  sourceUrl?: string;
  sourceTitle?: string;
  capturedAt: string;
  order: number;
};

export type ResourceDuplicateHashes = {
  content: string;
  evidence: string;
  source: string;
};

export type ResourceRow = {
  id: RecordRef;
  workspace: RecordRef;
  resource_type: string;
  title: string;
  summary: string;
  source_url?: string;
  source_title?: string;
  evidence: ResourceEvidence[];
  tags: string[];
  structured_payload: Record<string, unknown>;
  quality: ResourceQuality;
  confidence?: number;
  source_trust?: string;
  content_hash: string;
  evidence_hash: string;
  source_hash: string;
  research_session?: RecordRef;
  created_by: RecordRef;
  created_at: Date | string;
  updated_at: Date | string;
};

export type ResearchSessionStatus = "open" | "completed" | "cancelled";

export type ResearchSessionRow = {
  id: RecordRef;
  workspace: RecordRef;
  originating_run_id?: string;
  query: string;
  context: Record<string, unknown>;
  resource_type: string;
  status: ResearchSessionStatus;
  created_resources: RecordRef[];
  created_by: RecordRef;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at?: Date | string;
  cancelled_at?: Date | string;
};

export type ResearchSessionDTO = {
  id: string;
  workspaceId: string;
  originatingRunId?: string;
  query: string;
  context: Record<string, unknown>;
  resourceType: string;
  status: ResearchSessionStatus;
  resourceIds: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelledAt?: string;
};

export type ResourceEmbeddingStatus = "disabled" | "pending" | "indexed" | "failed" | "stale";

export type ResourceEmbeddingDTO = {
  status: ResourceEmbeddingStatus;
  profileKey?: string;
  provider?: string;
  model?: string;
  dimensions?: number;
  version?: string;
  errorSummary?: string;
  indexedAt?: string;
  updatedAt?: string;
};

export type ResourceEmbeddingRow = {
  id: RecordRef;
  workspace: RecordRef;
  resource: RecordRef;
  profile_key: string;
  provider: string;
  model: string;
  dimensions: number;
  profile_version: string;
  embedding_text_hash: string;
  vector?: number[];
  status: ResourceEmbeddingStatus;
  error_summary?: string;
  indexed_at?: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
};

export type ResourceDTO = {
  id: string;
  workspaceId: string;
  resourceType: string;
  title: string;
  summary: string;
  sourceUrl?: string;
  sourceTitle?: string;
  evidence: ResourceEvidence[];
  tags: string[];
  structuredPayload: Record<string, unknown>;
  quality: ResourceQuality;
  confidence?: number;
  sourceTrust?: string;
  duplicateHashes: ResourceDuplicateHashes;
  embedding: ResourceEmbeddingDTO;
  researchSessionId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type SaveResourceRequest = {
  workspaceId: string;
  resourceType: string;
  title: string;
  summary: string;
  sourceUrl?: string;
  sourceTitle?: string;
  evidence: ResourceEvidence[];
  tags?: string[];
  structuredPayload?: Record<string, unknown>;
  quality: ResourceQuality;
  confidence?: number;
  sourceTrust?: string;
  researchSessionId?: string;
};

export type SaveResourceResponse = {
  resource: ResourceDTO;
};

export type SaveResearchResourceRequest = Omit<
  SaveResourceRequest,
  "workspaceId" | "resourceType" | "researchSessionId"
> & {
  sessionId: string;
  resourceType?: string;
};

export type GetResourceDetailRequest = {
  resourceId: string;
};

export type ResourceDetailResponse = {
  resource: ResourceDTO;
  session?: {
    id: string;
    status: ResearchSessionStatus;
    query: string;
    resourceIds: string[];
  };
};

export type ResourceSearchContext = {
  selectedRow?: {
    id?: string;
    label?: string;
    visibleValues?: Record<string, unknown>;
  } | Record<string, unknown>;
  document?: {
    title?: string;
    text?: string;
  } | string;
  manualText?: string;
};

export type ResourceSearchFilters = {
  tags?: string[];
  sourceDomain?: string;
  dateFrom?: string;
  dateTo?: string;
};

export type ResourceSearchStatus = "hit" | "candidates" | "miss";
export type ResourceSearchIndexStatus = "ready" | "index-disabled" | "index-pending" | "index-error";

export type SearchResourcesRequest = {
  workspaceId: string;
  query: string;
  context?: ResourceSearchContext;
  resourceType?: string;
  filters?: ResourceSearchFilters;
  limit?: number;
  answerThreshold?: number;
  candidateThreshold?: number;
};

export type ResourceSearchResult = {
  resource: ResourceDTO;
  score: number;
  vectorScore: number;
  keywordScore: number;
  qualityScore: number;
  recencyScore: number;
};

export type SearchResourcesResponse = {
  status: ResourceSearchStatus;
  indexStatus: ResourceSearchIndexStatus;
  queryText: string;
  results: ResourceSearchResult[];
};

export type SearchResourceEmbeddingsRequest = {
  workspaceId: string;
  profile: ResourceEmbeddingProfile;
  vector: number[];
  limit?: number;
};

export type SearchResourceEmbeddingsResponse = {
  matches: Array<{
    resourceId: string;
    profileKey: string;
    score: number;
  }>;
};

export type UpdateEmbeddingProfileRequest = {
  workspaceId: string;
  profile: ResourceEmbeddingProfile;
};

export type UpdateEmbeddingProfileResponse = {
  profile: ResourceEmbeddingDTO;
  staleCount: number;
};

export type RetryResourceEmbeddingRequest = {
  resourceId: string;
};

export type RetryResourceEmbeddingResponse = {
  embedding: ResourceEmbeddingDTO;
};

export type CreateResearchSessionRequest = {
  workspaceId: string;
  query: string;
  context?: Record<string, unknown>;
  resourceType: string;
  originatingRunId?: string;
};

export type ResearchSessionResponse = {
  session: ResearchSessionDTO;
};

export type GetResearchSessionRequest = {
  sessionId: string;
};

export type CompleteResearchSessionRequest = {
  sessionId: string;
  resourceIds?: string[];
};

export type CancelResearchSessionRequest = {
  sessionId: string;
};

export type ResourceRepository = {
  createResource(input: Omit<ResourceRow, "id" | "research_session">): Promise<ResourceRow>;
  findResourceById(resourceId: string): Promise<ResourceRow | null>;
  listResourcesByWorkspace(workspaceId: string): Promise<ResourceRow[]>;
  upsertResourceEmbedding(input: Omit<ResourceEmbeddingRow, "id">): Promise<ResourceEmbeddingRow>;
  findResourceEmbeddingsByResource(resourceId: string): Promise<ResourceEmbeddingRow[]>;
  listIndexedResourceEmbeddings(workspaceId: string, profileKey: string): Promise<ResourceEmbeddingRow[]>;
  markResourceEmbeddingsStaleForWorkspace(workspaceId: string, activeProfileKey: string, updatedAt: Date): Promise<number>;
  createResearchSession(input: Omit<ResearchSessionRow, "id">): Promise<ResearchSessionRow>;
  findResearchSessionById(sessionId: string): Promise<ResearchSessionRow | null>;
  updateResearchSession(
    sessionId: string,
    patch: Partial<Omit<ResearchSessionRow, "id">>,
  ): Promise<ResearchSessionRow | null>;
  // 本地私有伴随：把 shared resource_item 与 research_session 的关联保存在本地，不进入 remote payload
  linkResourceToResearchSession(resourceId: string, sessionId: string): Promise<void>;
  findResearchSessionIdByResource(resourceId: string): Promise<string | null>;
};

export class SurrealResourceRepository implements ResourceRepository {
  constructor(private readonly db = getLocalDb()) {}

  async createResource(input: Omit<ResourceRow, "id" | "research_session">): Promise<ResourceRow> {
    const created = await this.db
      .create<ResourceRow>(new Table("resource_item"))
      .content(omitNullishSurrealFields({
        workspace: toRecordId(input.workspace),
        resource_type: input.resource_type,
        title: input.title,
        summary: input.summary,
        source_url: input.source_url,
        source_title: input.source_title,
        evidence: input.evidence,
        tags: input.tags,
        structured_payload: input.structured_payload,
        quality: input.quality,
        confidence: input.confidence,
        source_trust: input.source_trust,
        content_hash: input.content_hash,
        evidence_hash: input.evidence_hash,
        source_hash: input.source_hash,
        created_by: toRecordId(input.created_by),
        created_at: toDateTime(input.created_at),
        updated_at: toDateTime(input.updated_at),
      }));
    return requireRow(created, "资源创建后读取失败");
  }

  async linkResourceToResearchSession(resourceId: string, sessionId: string): Promise<void> {
    await this.db.query(
      `UPSERT $linkId CONTENT { resource: $resource, session: $session, updated_at: time::now() }`,
      {
        linkId: new RecordId("local_resource_session_link", stableHash({ resource: resourceId })),
        resource: new StringRecordId(resourceId),
        session: new StringRecordId(sessionId),
      },
    );
  }

  async findResearchSessionIdByResource(resourceId: string): Promise<string | null> {
    const rows = await this.db.query<[Array<{ session: RecordRef }>]>(
      `SELECT session FROM local_resource_session_link WHERE resource = $resource LIMIT 1`,
      { resource: new StringRecordId(resourceId) },
    );
    const row = rows[0]?.[0];
    return row?.session ? String(row.session) : null;
  }

  async findResourceById(resourceId: string): Promise<ResourceRow | null> {
    const rows = await this.db.query<[ResourceRow[]]>(
      `SELECT * FROM resource_item WHERE id = $resourceId LIMIT 1`,
      { resourceId: new StringRecordId(resourceId) },
    );
    return rows[0]?.[0] ?? null;
  }

  async listResourcesByWorkspace(workspaceId: string): Promise<ResourceRow[]> {
    const rows = await this.db.select<ResourceRow>(new Table("resource_item"));
    return rows.filter((row) => String(row.workspace) === workspaceId);
  }

  async upsertResourceEmbedding(input: Omit<ResourceEmbeddingRow, "id">): Promise<ResourceEmbeddingRow> {
    const id = new RecordId("resource_embedding", stableHash({
      resource: String(input.resource),
      profileKey: input.profile_key,
    }));
    const rows = await this.db.query<[ResourceEmbeddingRow[]]>(
      `UPSERT $id CONTENT $content RETURN AFTER`,
      {
        id,
        content: omitNullishSurrealFields({
          workspace: toRecordId(input.workspace),
          resource: toRecordId(input.resource),
          profile_key: input.profile_key,
          provider: input.provider,
          model: input.model,
          dimensions: input.dimensions,
          profile_version: input.profile_version,
          embedding_text_hash: input.embedding_text_hash,
          vector: input.vector,
          status: input.status,
          error_summary: input.error_summary,
          indexed_at: input.indexed_at ? toDateTime(input.indexed_at) : undefined,
          created_at: toDateTime(input.created_at),
          updated_at: toDateTime(input.updated_at),
        }),
      },
    );
    return requireRow(rows[0], "资源 embedding 状态写入后读取失败");
  }

  async findResourceEmbeddingsByResource(resourceId: string): Promise<ResourceEmbeddingRow[]> {
    const rows = await this.db.query<[ResourceEmbeddingRow[]]>(
      `SELECT * FROM resource_embedding WHERE resource = $resourceId`,
      { resourceId: new StringRecordId(resourceId) },
    );
    return rows[0] ?? [];
  }

  async listIndexedResourceEmbeddings(workspaceId: string, profileKey: string): Promise<ResourceEmbeddingRow[]> {
    const rows = await this.db.query<[ResourceEmbeddingRow[]]>(
      `SELECT * FROM resource_embedding
       WHERE workspace = $workspaceId
         AND profile_key = $profileKey
         AND status = "indexed"`,
      { workspaceId: new StringRecordId(workspaceId), profileKey },
    );
    return rows[0] ?? [];
  }

  async markResourceEmbeddingsStaleForWorkspace(
    workspaceId: string,
    activeProfileKey: string,
    updatedAt: Date,
  ): Promise<number> {
    const rows = await this.db.query<[ResourceEmbeddingRow[]]>(
      `UPDATE resource_embedding
       SET status = "stale",
           updated_at = $updatedAt
       WHERE workspace = $workspaceId
         AND profile_key != $activeProfileKey
         AND status INSIDE ["pending", "indexed", "failed"]
       RETURN AFTER`,
      {
        workspaceId: new StringRecordId(workspaceId),
        activeProfileKey,
        updatedAt: toDateTime(updatedAt),
      },
    );
    return rows[0]?.length ?? 0;
  }

  async createResearchSession(input: Omit<ResearchSessionRow, "id">): Promise<ResearchSessionRow> {
    const created = await this.db
      .create<ResearchSessionRow>(new Table("research_session"))
      .content(omitNullishSurrealFields({
        workspace: toRecordId(input.workspace),
        originating_run_id: input.originating_run_id,
        query: input.query,
        context: input.context,
        resource_type: input.resource_type,
        status: input.status,
        created_resources: input.created_resources.map(toRecordId),
        created_by: toRecordId(input.created_by),
        created_at: toDateTime(input.created_at),
        updated_at: toDateTime(input.updated_at),
        completed_at: input.completed_at ? toDateTime(input.completed_at) : undefined,
        cancelled_at: input.cancelled_at ? toDateTime(input.cancelled_at) : undefined,
      }));
    return requireRow(created, "检索会话创建后读取失败");
  }

  async findResearchSessionById(sessionId: string): Promise<ResearchSessionRow | null> {
    const rows = await this.db.query<[ResearchSessionRow[]]>(
      `SELECT * FROM research_session WHERE id = $sessionId LIMIT 1`,
      { sessionId: new StringRecordId(sessionId) },
    );
    return rows[0]?.[0] ?? null;
  }

  async updateResearchSession(
    sessionId: string,
    patch: Partial<Omit<ResearchSessionRow, "id">>,
  ): Promise<ResearchSessionRow | null> {
    const values: Record<string, unknown> = {};
    if (patch.workspace !== undefined) values.workspace = toRecordId(patch.workspace);
    if (patch.originating_run_id !== undefined) values.originating_run_id = patch.originating_run_id;
    if (patch.query !== undefined) values.query = patch.query;
    if (patch.context !== undefined) values.context = patch.context;
    if (patch.resource_type !== undefined) values.resource_type = patch.resource_type;
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.created_resources !== undefined) values.created_resources = patch.created_resources.map(toRecordId);
    if (patch.created_by !== undefined) values.created_by = toRecordId(patch.created_by);
    if (patch.created_at !== undefined) values.created_at = toDateTime(patch.created_at);
    if (patch.updated_at !== undefined) values.updated_at = toDateTime(patch.updated_at);
    if (patch.completed_at !== undefined) values.completed_at = toDateTime(patch.completed_at);
    if (patch.cancelled_at !== undefined) values.cancelled_at = toDateTime(patch.cancelled_at);

    const updated = await this.db
      .update<ResearchSessionRow>(new StringRecordId(sessionId))
      .merge(values);
    return unwrapMaybeRow(updated);
  }
}

type ResourceServiceDeps = {
  repository: ResourceRepository;
  assertCanReadWorkspace(workspaceId: string): Promise<void>;
  assertCanPerformWrite(capability: CapabilityKey, workspaceId?: string): Promise<void>;
  getCurrentUserRecordId(): Promise<RecordRef>;
  getActiveEmbeddingProfile?(workspaceId: string): Promise<ResourceEmbeddingProfile | null>;
  saveActiveEmbeddingProfile?(workspaceId: string, profile: ResourceEmbeddingProfile): Promise<void>;
  generateEmbedding?(input: {
    profile: ResourceEmbeddingProfile;
    resource: ResourceRow;
    text: string;
    embeddingTextHash: string;
  }): Promise<number[]>;
  generateSearchEmbedding?(input: {
    profile: ResourceEmbeddingProfile;
    text: string;
  }): Promise<number[]>;
  now?: () => Date;
};

export function createResourceService(deps: ResourceServiceDeps) {
  const now = deps.now ?? (() => new Date());

  const api = {
    async saveResource(req: SaveResourceRequest): Promise<SaveResourceResponse> {
      await deps.assertCanPerformWrite("publish_shared_resource", req.workspaceId);
      const currentUserId = await deps.getCurrentUserRecordId();
      const { normalized, duplicateHashes } = prepareSharedResourceDraft(req);
      const session = normalized.researchSessionId
        ? await loadOpenResearchSessionForResource(deps.repository, normalized.researchSessionId, normalized.workspaceId)
        : null;
      if (session) {
        await deps.assertCanPerformWrite("write_research_session", normalized.workspaceId);
      }
      const timestamp = now();

      const row = await deps.repository.createResource({
        workspace: normalized.workspaceId,
        resource_type: normalized.resourceType,
        title: normalized.title,
        summary: normalized.summary,
        source_url: normalized.sourceUrl,
        source_title: normalized.sourceTitle,
        evidence: normalized.evidence,
        tags: normalized.tags,
        structured_payload: normalized.structuredPayload,
        quality: normalized.quality,
        confidence: normalized.confidence,
        source_trust: normalized.sourceTrust,
        content_hash: duplicateHashes.content,
        evidence_hash: duplicateHashes.evidence,
        source_hash: duplicateHashes.source,
        created_by: currentUserId,
        created_at: timestamp,
        updated_at: timestamp,
      });

      if (session) {
        await linkPublishedResourceToOpenSession(deps.repository, {
          session,
          resourceId: row.id,
          timestamp,
        });
      }

      const embedding = await ensureInitialEmbeddingState(deps, row, timestamp);

      return { resource: resourceRowToDTO(row, embedding, normalized.researchSessionId) };
    },

    async saveResearchResource(req: SaveResearchResourceRequest): Promise<SaveResourceResponse> {
      const session = await deps.repository.findResearchSessionById(req.sessionId);
      if (!session) throw new ServiceError("NOT_FOUND", "检索会话不存在");
      if (session.status !== "open") {
        throw new ServiceError("VALIDATION_ERROR", "只能向 open 状态的检索会话保存资源");
      }
      return api.saveResource({
        ...req,
        workspaceId: String(session.workspace),
        resourceType: req.resourceType?.trim() || session.resource_type,
        researchSessionId: req.sessionId,
      });
    },

    async getResourceDetail(req: GetResourceDetailRequest): Promise<ResourceDetailResponse> {
      const row = await deps.repository.findResourceById(req.resourceId);
      if (!row) throw new ServiceError("NOT_FOUND", "资源不存在");

      await deps.assertCanReadWorkspace(String(row.workspace));
      const embedding = await resolveResourceEmbeddingState(deps, row);
      const linkedSessionId = await deps.repository.findResearchSessionIdByResource(
        String(row.id),
      );
      const resource = resourceRowToDTO(row, embedding, linkedSessionId ?? undefined);
      const session = resource.researchSessionId
        ? await deps.repository.findResearchSessionById(resource.researchSessionId)
        : null;

      return {
        resource,
        session: session ? researchSessionSummary(session) : undefined,
      };
    },

    async searchResources(req: SearchResourcesRequest): Promise<SearchResourcesResponse> {
      await deps.assertCanReadWorkspace(req.workspaceId);
      const queryText = buildResourceSearchText(req);
      if (!queryText) throw new ServiceError("VALIDATION_ERROR", "检索 query 不能为空");
      if (req.resourceType) validateResourceType(req.resourceType.trim());

      const rows = (await deps.repository.listResourcesByWorkspace(req.workspaceId))
        .filter((row) => !req.resourceType || row.resource_type === req.resourceType.trim());
      const profile = await deps.getActiveEmbeddingProfile?.(req.workspaceId) ?? null;
      const vectorSearch = await buildVectorScoreMap(deps, {
        workspaceId: req.workspaceId,
        queryText,
        rows,
        profile,
      });
      const ranked = rankResourceSearchRows({
        rows,
        queryText,
        vectorScores: vectorSearch.scores,
        filters: req.filters,
        now: now(),
        limit: req.limit,
        answerThreshold: req.answerThreshold,
        candidateThreshold: req.candidateThreshold,
      });
      const results = await Promise.all(ranked.results.map(async (item) => ({
        resource: resourceRowToDTO(item.row, await resolveResourceEmbeddingState(deps, item.row)),
        score: item.score,
        vectorScore: item.vectorScore,
        keywordScore: item.keywordScore,
        qualityScore: item.qualityScore,
        recencyScore: item.recencyScore,
      })));

      return { status: ranked.status, indexStatus: vectorSearch.indexStatus, queryText, results };
    },

    async searchResourceEmbeddings(req: SearchResourceEmbeddingsRequest): Promise<SearchResourceEmbeddingsResponse> {
      await deps.assertCanReadWorkspace(req.workspaceId);
      const profileKey = createEmbeddingProfileKey(req.profile);
      const rows = await deps.repository.listIndexedResourceEmbeddings(req.workspaceId, profileKey);
      const matches = rows
        .filter((row) => row.vector && row.vector.length > 0)
        .map((row) => ({
          resourceId: String(row.resource),
          profileKey: row.profile_key,
          score: cosineSimilarity(req.vector, row.vector ?? []),
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, req.limit ?? 10);

      return { matches };
    },

    async updateEmbeddingProfile(req: UpdateEmbeddingProfileRequest): Promise<UpdateEmbeddingProfileResponse> {
      await deps.assertCanPerformWrite("advance_shared_embedding", req.workspaceId);
      const profile = normalizeEmbeddingProfile(req.profile);
      await deps.saveActiveEmbeddingProfile?.(req.workspaceId, profile);
      const timestamp = now();
      const { staleCount } = await prepareWorkspaceEmbeddingProfileChange({
        repository: deps.repository,
        workspaceId: req.workspaceId,
        profile,
        timestamp,
      });

      return {
        profile: {
          status: "pending",
          ...embeddingProfileToDTOFields(profile),
          updatedAt: timestamp.toISOString(),
        },
        staleCount,
      };
    },

    async retryResourceEmbedding(req: RetryResourceEmbeddingRequest): Promise<RetryResourceEmbeddingResponse> {
      const row = await deps.repository.findResourceById(req.resourceId);
      if (!row) throw new ServiceError("NOT_FOUND", "资源不存在");

      await deps.assertCanPerformWrite("advance_shared_embedding", String(row.workspace));
      const embedding = await retryResourceEmbeddingState(deps, row, now());

      return { embedding };
    },

    async createResearchSession(req: CreateResearchSessionRequest): Promise<ResearchSessionResponse> {
      await deps.assertCanPerformWrite("write_research_session", req.workspaceId);
      const currentUserId = await deps.getCurrentUserRecordId();
      validateResourceType(req.resourceType.trim());
      const timestamp = now();

      const row = await deps.repository.createResearchSession({
        workspace: req.workspaceId,
        originating_run_id: optionalTrimmed(req.originatingRunId),
        query: requiredTrimmed(req.query, "检索问题不能为空"),
        context: req.context ?? {},
        resource_type: req.resourceType.trim(),
        status: "open",
        created_resources: [],
        created_by: currentUserId,
        created_at: timestamp,
        updated_at: timestamp,
      });

      return { session: researchSessionRowToDTO(row) };
    },

    async getResearchSession(req: GetResearchSessionRequest): Promise<ResearchSessionResponse> {
      const row = await deps.repository.findResearchSessionById(req.sessionId);
      if (!row) throw new ServiceError("NOT_FOUND", "检索会话不存在");

      await deps.assertCanReadWorkspace(String(row.workspace));
      return { session: researchSessionRowToDTO(row) };
    },

    async completeResearchSession(req: CompleteResearchSessionRequest): Promise<ResearchSessionResponse> {
      const row = await deps.repository.findResearchSessionById(req.sessionId);
      if (!row) throw new ServiceError("NOT_FOUND", "检索会话不存在");

      await deps.assertCanPerformWrite("write_research_session", String(row.workspace));
      if (row.status !== "open") {
        throw new ServiceError("VALIDATION_ERROR", "只能完成 open 状态的检索会话");
      }

      const timestamp = now();
      const updated = await deps.repository.updateResearchSession(req.sessionId, {
        status: "completed",
        created_resources: uniqueRecordRefs([...row.created_resources, ...(req.resourceIds ?? [])]),
        completed_at: timestamp,
        updated_at: timestamp,
      });
      if (!updated) throw new ServiceError("NOT_FOUND", "检索会话不存在");
      return { session: researchSessionRowToDTO(updated) };
    },

    async cancelResearchSession(req: CancelResearchSessionRequest): Promise<ResearchSessionResponse> {
      const row = await deps.repository.findResearchSessionById(req.sessionId);
      if (!row) throw new ServiceError("NOT_FOUND", "检索会话不存在");

      await deps.assertCanPerformWrite("write_research_session", String(row.workspace));
      if (row.status !== "open") {
        throw new ServiceError("VALIDATION_ERROR", "只能取消 open 状态的检索会话");
      }

      const timestamp = now();
      const updated = await deps.repository.updateResearchSession(req.sessionId, {
        status: "cancelled",
        cancelled_at: timestamp,
        updated_at: timestamp,
      });
      if (!updated) throw new ServiceError("NOT_FOUND", "检索会话不存在");
      return { session: researchSessionRowToDTO(updated) };
    },
  };
  return api;
}

export async function saveResource(req: SaveResourceRequest): Promise<SaveResourceResponse> {
  const result = await createDefaultResourceService().saveResource(req);
  queueDefaultResourceEmbedding(result.resource.id);
  return result;
}

export async function saveResearchResource(req: SaveResearchResourceRequest): Promise<SaveResourceResponse> {
  const result = await createDefaultResourceService().saveResearchResource(req);
  queueDefaultResourceEmbedding(result.resource.id);
  return result;
}

export function getResourceDetail(req: GetResourceDetailRequest): Promise<ResourceDetailResponse> {
  return createDefaultResourceService().getResourceDetail(req);
}

export function searchResources(req: SearchResourcesRequest): Promise<SearchResourcesResponse> {
  return createDefaultResourceService({ searchEmbedding: true }).searchResources(req);
}

export function createResearchSession(req: CreateResearchSessionRequest): Promise<ResearchSessionResponse> {
  return createDefaultResourceService().createResearchSession(req);
}

export function getResearchSession(req: GetResearchSessionRequest): Promise<ResearchSessionResponse> {
  return createDefaultResourceService().getResearchSession(req);
}

export function completeResearchSession(req: CompleteResearchSessionRequest): Promise<ResearchSessionResponse> {
  return createDefaultResourceService().completeResearchSession(req);
}

export function cancelResearchSession(req: CancelResearchSessionRequest): Promise<ResearchSessionResponse> {
  return createDefaultResourceService().cancelResearchSession(req);
}

export function searchResourceEmbeddings(req: SearchResourceEmbeddingsRequest): Promise<SearchResourceEmbeddingsResponse> {
  return createDefaultResourceService().searchResourceEmbeddings(req);
}

export function updateEmbeddingProfile(req: UpdateEmbeddingProfileRequest): Promise<UpdateEmbeddingProfileResponse> {
  return createDefaultResourceService().updateEmbeddingProfile(req);
}

export async function retryResourceEmbedding(req: RetryResourceEmbeddingRequest): Promise<RetryResourceEmbeddingResponse> {
  const result = await createDefaultResourceService().retryResourceEmbedding(req);
  queueDefaultResourceEmbedding(req.resourceId);
  return result;
}

function createDefaultResourceService(
  options: { searchEmbedding?: boolean } = {},
): ReturnType<typeof createResourceService> {
  const embeddingProfileRepository = new SurrealWorkspaceEmbeddingProfileRepository();
  return createResourceService({
    repository: new SurrealResourceRepository(),
    assertCanReadWorkspace,
    assertCanPerformWrite: assertCanPerformSharedWrite,
    getCurrentUserRecordId,
    getActiveEmbeddingProfile: async (workspaceId) => {
      const row = await embeddingProfileRepository.findByWorkspace(workspaceId);
      return row ? workspaceEmbeddingProfileRowToProfile(row) : null;
    },
    saveActiveEmbeddingProfile: async (workspaceId, profile) => {
      await embeddingProfileRepository.saveForWorkspace(workspaceId, profile, new Date());
    },
    generateSearchEmbedding: options.searchEmbedding
      ? async ({ profile, text }) => {
        const settings = await getCompatibleEmbeddingSettings(profile);
        if (!settings) throw new ServiceError("VALIDATION_ERROR", "当前设备没有兼容的 embedding credential");
        return generateEmbeddingVector(settings, text);
      }
      : undefined,
  });
}

function queueDefaultResourceEmbedding(resourceId: string): void {
  void indexDefaultResourceEmbedding(resourceId).catch(() => undefined);
}

async function indexDefaultResourceEmbedding(resourceId: string): Promise<void> {
  const repository = new SurrealResourceRepository();
  const row = await repository.findResourceById(resourceId);
  if (!row) return;

  await assertCanPerformSharedWrite("advance_shared_embedding", String(row.workspace));

  const profileRepository = new SurrealWorkspaceEmbeddingProfileRepository();
  const profileRow = await profileRepository.findByWorkspace(String(row.workspace));
  if (!profileRow) return;
  const profile = workspaceEmbeddingProfileRowToProfile(profileRow);
  const settings = await getCompatibleEmbeddingSettings(profile);
  if (!settings) return;

  await indexResourceEmbedding({
    repository,
    row,
    profile,
    timestamp: new Date(),
    generateEmbedding: (text) => generateEmbeddingVector(settings, text),
  });
}

async function getCompatibleEmbeddingSettings(
  profile: ResourceEmbeddingProfile,
): Promise<EmbeddingSettings | null> {
  const settings = await getEmbeddingSettings();
  if (!settings.secretConfigured || !settings.apiKey?.trim()) return null;

  const provider = normalizeSettingsProvider(profile.provider);
  if (settings.provider !== provider) return null;

  return {
    provider,
    model: profile.model,
    dimensions: profile.dimensions,
    version: profile.version,
    baseUrl: profile.baseUrl ?? settings.baseUrl,
    apiFormat: normalizeSettingsApiFormat(profile.apiFormat ?? settings.apiFormat),
    apiKey: settings.apiKey,
    secretConfigured: true,
  };
}

function normalizeSettingsProvider(provider: string): AiProvider {
  if (provider === "anthropic" || provider === "google" || provider === "custom") return provider;
  return "openai";
}

function normalizeSettingsApiFormat(apiFormat: string | undefined): AiApiFormat {
  if (apiFormat === "openai-responses" || apiFormat === "anthropic") return apiFormat;
  return "openai-compatible";
}

function cosineSimilarity(left: number[], right: number[]): number {
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

function requiredTrimmed(value: string, message: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ServiceError("VALIDATION_ERROR", message);
  return trimmed;
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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

function resourceRowToDTO(
  row: ResourceRow,
  embedding: ResourceEmbeddingDTO = { status: "disabled" },
  researchSessionId?: string,
): ResourceDTO {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace),
    resourceType: row.resource_type,
    title: row.title,
    summary: row.summary,
    sourceUrl: row.source_url,
    sourceTitle: row.source_title,
    evidence: row.evidence,
    tags: row.tags,
    structuredPayload: row.structured_payload,
    quality: row.quality,
    confidence: row.confidence,
    sourceTrust: row.source_trust,
    duplicateHashes: {
      content: row.content_hash,
      evidence: row.evidence_hash,
      source: row.source_hash,
    },
    embedding,
    researchSessionId: researchSessionId ?? (row.research_session ? String(row.research_session) : undefined),
    createdBy: String(row.created_by),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function researchSessionRowToDTO(row: ResearchSessionRow): ResearchSessionDTO {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace),
    originatingRunId: row.originating_run_id,
    query: row.query,
    context: row.context,
    resourceType: row.resource_type,
    status: row.status,
    resourceIds: row.created_resources.map(String),
    createdBy: String(row.created_by),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    completedAt: row.completed_at ? toIso(row.completed_at) : undefined,
    cancelledAt: row.cancelled_at ? toIso(row.cancelled_at) : undefined,
  };
}

function toIso(value: Date | DateTime | string): string {
  if (value instanceof DateTime) return value.toDate().toISOString();
  return value instanceof Date ? value.toISOString() : value;
}

function uniqueRecordRefs(values: RecordRef[]): RecordRef[] {
  const seen = new Set<string>();
  const result: RecordRef[] = [];
  for (const value of values) {
    const key = String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function toRecordId(value: RecordRef): RecordId | StringRecordId {
  if (typeof value === "string") return new StringRecordId(value);
  return value;
}

function toDateTime(value: Date | DateTime | string): DateTime {
  if (value instanceof DateTime) return value;
  return new DateTime(value instanceof Date ? value : new Date(value));
}

function requireRow<T>(value: T | T[] | undefined | null, message: string): T {
  const row = unwrapMaybeRow(value);
  if (!row) throw new ServiceError("INTERNAL_ERROR", message);
  return row;
}

function unwrapMaybeRow<T>(value: T | T[] | undefined | null): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}
