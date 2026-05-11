import { createHash } from "node:crypto";
import { z } from "zod";
import { DateTime, RecordId, StringRecordId, Table } from "surrealdb";
import { getLocalDb } from "../db/index";
import { omitNullishSurrealFields } from "../db/surreal-values";
import { assertCanReadWorkspace, assertCanWriteWorkspace, getCurrentUserRecordId } from "./context";
import { ServiceError } from "./errors";

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
  createResource(input: Omit<ResourceRow, "id">): Promise<ResourceRow>;
  findResourceById(resourceId: string): Promise<ResourceRow | null>;
  createResearchSession(input: Omit<ResearchSessionRow, "id">): Promise<ResearchSessionRow>;
  findResearchSessionById(sessionId: string): Promise<ResearchSessionRow | null>;
  updateResearchSession(
    sessionId: string,
    patch: Partial<Omit<ResearchSessionRow, "id">>,
  ): Promise<ResearchSessionRow | null>;
};

export class SurrealResourceRepository implements ResourceRepository {
  constructor(private readonly db = getLocalDb()) {}

  async createResource(input: Omit<ResourceRow, "id">): Promise<ResourceRow> {
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
        research_session: input.research_session ? toRecordId(input.research_session) : undefined,
        created_by: toRecordId(input.created_by),
        created_at: toDateTime(input.created_at),
        updated_at: toDateTime(input.updated_at),
      }));
    return requireRow(created, "资源创建后读取失败");
  }

  async findResourceById(resourceId: string): Promise<ResourceRow | null> {
    const rows = await this.db.query<[ResourceRow[]]>(
      `SELECT * FROM resource_item WHERE id = $resourceId LIMIT 1`,
      { resourceId: new StringRecordId(resourceId) },
    );
    return rows[0]?.[0] ?? null;
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
  assertCanWriteWorkspace(workspaceId: string): Promise<void>;
  getCurrentUserRecordId(): Promise<RecordRef>;
  now?: () => Date;
};

const EvidenceSchema = z.object({
  text: z.string().trim().min(1),
  sourceUrl: z.string().trim().url().optional(),
  sourceTitle: z.string().trim().min(1).optional(),
  capturedAt: z.string().datetime(),
  order: z.number().int().nonnegative(),
});

const ResourceQualitySchema = z.enum(["user-confirmed", "ai-draft", "imported", "deprecated"]);

const ResourceTypeRegistry = {
  generic_note: z.object({}).strict(),
  web_article: z.object({
    author: z.string().trim().min(1).optional(),
    publishedAt: z.string().datetime().optional(),
    siteName: z.string().trim().min(1).optional(),
  }).strict(),
} satisfies Record<string, z.ZodType<Record<string, unknown>>>;

export function createResourceService(deps: ResourceServiceDeps) {
  const now = deps.now ?? (() => new Date());

  return {
    async saveResource(req: SaveResourceRequest): Promise<SaveResourceResponse> {
      await deps.assertCanWriteWorkspace(req.workspaceId);
      const currentUserId = await deps.getCurrentUserRecordId();
      const normalized = normalizeSaveResourceRequest(req);
      const session = normalized.researchSessionId
        ? await loadOpenSessionForWrite(deps, normalized.researchSessionId, normalized.workspaceId)
        : null;
      const timestamp = now();
      const hashes = createDuplicateHashes(normalized);

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
        content_hash: hashes.content,
        evidence_hash: hashes.evidence,
        source_hash: hashes.source,
        research_session: normalized.researchSessionId,
        created_by: currentUserId,
        created_at: timestamp,
        updated_at: timestamp,
      });

      if (session) {
        await deps.repository.updateResearchSession(String(session.id), {
          created_resources: uniqueRecordRefs([...session.created_resources, row.id]),
          updated_at: timestamp,
        });
      }

      return { resource: resourceRowToDTO(row) };
    },

    async getResourceDetail(req: GetResourceDetailRequest): Promise<ResourceDetailResponse> {
      const row = await deps.repository.findResourceById(req.resourceId);
      if (!row) throw new ServiceError("NOT_FOUND", "资源不存在");

      await deps.assertCanReadWorkspace(String(row.workspace));
      const resource = resourceRowToDTO(row);
      const session = resource.researchSessionId
        ? await deps.repository.findResearchSessionById(resource.researchSessionId)
        : null;

      return {
        resource,
        session: session ? researchSessionRowToSummary(session) : undefined,
      };
    },

    async createResearchSession(req: CreateResearchSessionRequest): Promise<ResearchSessionResponse> {
      await deps.assertCanWriteWorkspace(req.workspaceId);
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

      await deps.assertCanWriteWorkspace(String(row.workspace));
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

      await deps.assertCanWriteWorkspace(String(row.workspace));
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
}

export function saveResource(req: SaveResourceRequest): Promise<SaveResourceResponse> {
  return createDefaultResourceService().saveResource(req);
}

export function getResourceDetail(req: GetResourceDetailRequest): Promise<ResourceDetailResponse> {
  return createDefaultResourceService().getResourceDetail(req);
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

function createDefaultResourceService(): ReturnType<typeof createResourceService> {
  return createResourceService({
    repository: new SurrealResourceRepository(),
    assertCanReadWorkspace,
    assertCanWriteWorkspace,
    getCurrentUserRecordId,
  });
}

async function loadOpenSessionForWrite(
  deps: Pick<ResourceServiceDeps, "repository">,
  sessionId: string,
  workspaceId: string,
): Promise<ResearchSessionRow> {
  const session = await deps.repository.findResearchSessionById(sessionId);
  if (!session) throw new ServiceError("NOT_FOUND", "检索会话不存在");
  if (String(session.workspace) !== workspaceId) {
    throw new ServiceError("VALIDATION_ERROR", "资源与检索会话不属于同一工作区");
  }
  if (session.status !== "open") {
    throw new ServiceError("VALIDATION_ERROR", "只能向 open 状态的检索会话保存资源");
  }
  return session;
}

function normalizeSaveResourceRequest(req: SaveResourceRequest): Required<
  Pick<SaveResourceRequest, "workspaceId" | "resourceType" | "title" | "summary" | "evidence" | "tags" | "structuredPayload" | "quality">
> & Omit<SaveResourceRequest, "workspaceId" | "resourceType" | "title" | "summary" | "evidence" | "tags" | "structuredPayload" | "quality"> {
  const resourceType = req.resourceType.trim();
  const structuredPayload = validateStructuredPayload(resourceType, req.structuredPayload ?? {});
  const evidenceParsed = z.array(EvidenceSchema).safeParse(req.evidence);
  if (!evidenceParsed.success) {
    throw new ServiceError("VALIDATION_ERROR", "证据段不符合资源保存要求");
  }
  const qualityParsed = ResourceQualitySchema.safeParse(req.quality);
  if (!qualityParsed.success) {
    throw new ServiceError("VALIDATION_ERROR", "资源质量不符合约束");
  }

  return {
    ...req,
    workspaceId: req.workspaceId,
    resourceType,
    title: requiredTrimmed(req.title, "标题不能为空"),
    summary: requiredTrimmed(req.summary, "摘要不能为空"),
    sourceUrl: optionalTrimmed(req.sourceUrl),
    sourceTitle: optionalTrimmed(req.sourceTitle),
    evidence: evidenceParsed.data,
    tags: [...new Set((req.tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
    structuredPayload,
    quality: qualityParsed.data,
  };
}

function validateStructuredPayload(resourceType: string, payload: Record<string, unknown>): Record<string, unknown> {
  const schema = validateResourceType(resourceType);

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ServiceError("VALIDATION_ERROR", "资源结构化 payload 不符合类型约束");
  }
  return parsed.data;
}

function validateResourceType(resourceType: string): z.ZodType<Record<string, unknown>> {
  const schema = ResourceTypeRegistry[resourceType as keyof typeof ResourceTypeRegistry];
  if (!schema) {
    throw new ServiceError("VALIDATION_ERROR", `未知资源类型: ${resourceType}`);
  }
  return schema;
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

function createDuplicateHashes(input: {
  resourceType: string;
  title: string;
  summary: string;
  sourceUrl?: string;
  sourceTitle?: string;
  evidence: ResourceEvidence[];
  tags: string[];
  structuredPayload: Record<string, unknown>;
}): ResourceDuplicateHashes {
  return {
    content: stableHash({
      resourceType: input.resourceType,
      title: input.title,
      summary: input.summary,
      tags: input.tags,
      structuredPayload: input.structuredPayload,
    }),
    evidence: stableHash(input.evidence.map((item) => ({
      text: item.text,
      sourceUrl: item.sourceUrl,
      sourceTitle: item.sourceTitle,
    }))),
    source: stableHash({
      sourceUrl: input.sourceUrl,
      sourceTitle: input.sourceTitle,
    }),
  };
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

function resourceRowToDTO(row: ResourceRow): ResourceDTO {
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
    researchSessionId: row.research_session ? String(row.research_session) : undefined,
    createdBy: String(row.created_by),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function researchSessionRowToSummary(row: ResearchSessionRow): NonNullable<ResourceDetailResponse["session"]> {
  return {
    id: String(row.id),
    status: row.status,
    query: row.query,
    resourceIds: row.created_resources.map(String),
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
