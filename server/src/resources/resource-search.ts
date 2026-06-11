/**
 * RR-014 资源检索读路径：自 legacy services/resource-search.ts / resources.ts 移植的
 * 已验证检索契约，适配 workspace-as-database schema（表不带 workspace 字段，隔离靠 db 边界）。
 *
 * 所有 SurrealDB 读写都走调用者 workspace session（admin / participant access），
 * 没有 root / service 兜底。向量相似度在服务层用余弦计算（V1；HNSW 索引按 profile
 * DIMENSION 由检索实现自建，见 008-resource-library.surql 注释），接口可替换。
 */
import { DateTime, StringRecordId } from "surrealdb";
import type { Surreal } from "surrealdb";
import {
  buildResourceEmbeddingText as buildDraftEmbeddingText,
  createEmbeddingProfileKey,
  type EmbeddingProfile,
  type EmbeddingProvider,
} from "./research-save";

// ─── 行 / DTO 类型（新 schema：无 workspace 字段） ───────────────────────────

export type ResourceQuality = "user-confirmed" | "ai-draft" | "imported" | "deprecated";

export type ResourceEvidence = {
  text: string;
  sourceUrl?: string;
  sourceTitle?: string;
  capturedAt: string;
  order: number;
};

export type ResourceItemRow = {
  id: unknown;
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
  created_by?: unknown;
  created_at: Date | DateTime | string;
  updated_at: Date | DateTime | string;
};

export type ResourceEmbeddingRow = {
  id: unknown;
  resource: unknown;
  profile_key: string;
  status: "disabled" | "pending" | "indexed" | "failed" | "stale";
  vector?: number[];
  error_summary?: string;
};

export type ResourceDTO = {
  id: string;
  workspaceId?: string;
  resourceType: string;
  title: string;
  summary: string;
  sourceUrl?: string;
  sourceTitle?: string;
  evidence: ResourceEvidence[];
  tags: string[];
  structuredPayload: Record<string, unknown>;
  quality: ResourceQuality;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type ResourceSearchContext = {
  selectedRow?: unknown;
  document?: { title?: string; text?: string } | string;
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
  /** 兼容旧契约字段；session 已绑定 workspace db，服务不再用它过滤。 */
  workspaceId?: string;
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

export type GetResourceDetailRequest = {
  resourceId: string;
};

export type ResourceDetailResponse = {
  resource: ResourceDTO & { researchSessionId?: string };
};

export type CreateResearchSessionRequest = {
  /** 兼容旧契约字段；session 已绑定 workspace db。 */
  workspaceId?: string;
  query: string;
  context?: Record<string, unknown>;
  resourceType: string;
  originatingRunId?: string;
};

export type ResearchSessionRow = {
  id: unknown;
  query: string;
  context: Record<string, unknown>;
  resource_type: string;
  status: "open" | "completed" | "cancelled";
  created_resources: unknown[];
  originating_run_id?: string;
  created_at: Date | DateTime | string;
  updated_at: Date | DateTime | string;
};

export type ResearchSessionDTO = {
  id: string;
  workspaceId?: string;
  query: string;
  context: Record<string, unknown>;
  resourceType: string;
  status: "open" | "completed" | "cancelled";
  resourceIds: string[];
  originatingRunId?: string;
  createdAt: string;
  updatedAt: string;
};

export type ResearchSessionResponse = {
  session: ResearchSessionDTO;
};

export type ResourceSearchServiceDeps = {
  /** 调用者 workspace session（OIDC token authenticate 出的 admin / participant access）。 */
  session: Surreal;
  /** 服务端持 key 的 embedding 生成器；缺席时只有关键词分，索引状态按 pending/error 推断。 */
  embeddingProvider?: EmbeddingProvider;
  now?: () => Date;
};

// ─── 检索文本与排序（纯逻辑，自 legacy resource-search.ts 移植） ─────────────

export function buildResourceSearchText(req: {
  query: string;
  context?: ResourceSearchContext;
}): string {
  return [
    req.query,
    contextValueToText(req.context?.selectedRow),
    contextValueToText(req.context?.document),
    req.context?.manualText,
  ]
    .filter((item): item is string => Boolean(item?.trim()))
    .join("\n")
    .trim();
}

export type RankedResourceRow = {
  row: ResourceItemRow;
  score: number;
  vectorScore: number;
  keywordScore: number;
  qualityScore: number;
  recencyScore: number;
};

export function rankResourceSearchRows(req: {
  rows: ResourceItemRow[];
  queryText: string;
  vectorScores: Map<string, number>;
  filters?: ResourceSearchFilters;
  now: Date;
  limit?: number;
  answerThreshold?: number;
  candidateThreshold?: number;
}): { status: ResourceSearchStatus; results: RankedResourceRow[] } {
  const scoredRows = req.rows
    .filter((row) => resourceMatchesFilters(row, req.filters))
    .map((row) => {
      const keywordScore = scoreKeyword(row, req.queryText);
      const vectorScore = req.vectorScores.get(String(row.id)) ?? 0;
      const qualityScore = scoreQuality(row.quality);
      const recencyScore = scoreRecency(row.created_at, req.now);
      const score =
        vectorScore * 0.45 + keywordScore * 0.35 + qualityScore * 0.12 + recencyScore * 0.08;
      return { row, score, vectorScore, keywordScore, qualityScore, recencyScore };
    });

  const results = scoredRows
    .filter((item) => item.keywordScore > 0 || req.vectorScores.has(String(item.row.id)))
    .sort((left, right) => right.score - left.score)
    .slice(0, clampPositiveInteger(req.limit, 10));
  const bestScore = results[0]?.score ?? 0;
  const answerThreshold = req.answerThreshold ?? 0.72;
  const candidateThreshold = req.candidateThreshold ?? 0.25;
  const status: ResourceSearchStatus = bestScore >= answerThreshold
    ? "hit"
    : bestScore >= candidateThreshold
      ? "candidates"
      : "miss";

  return { status, results };
}

function contextValueToText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contextValueToText).filter(Boolean).join("\n");
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .map(contextValueToText)
      .filter(Boolean)
      .join("\n");
  }
  return String(value);
}

function scoreKeyword(row: ResourceItemRow, queryText: string): number {
  const haystack = normalizeSearchText([
    row.title,
    row.summary,
    row.source_title,
    row.tags.join(" "),
    ...row.evidence.map((item) => item.text),
  ].filter(Boolean).join("\n"));
  const terms = tokenizeSearchText(queryText);
  if (terms.length === 0) return 0;

  let matches = 0;
  for (const term of terms) {
    if (haystack.includes(term)) matches += 1;
  }
  return matches / terms.length;
}

function tokenizeSearchText(text: string): string[] {
  const normalized = normalizeSearchText(text);
  const parts = normalized
    .split(/[\s,，。；;、]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  return [...new Set(parts.length > 0 ? parts : [normalized].filter(Boolean))];
}

function normalizeSearchText(text: string): string {
  return text.trim().toLowerCase();
}

function scoreQuality(quality: ResourceQuality): number {
  switch (quality) {
    case "user-confirmed":
      return 1;
    case "imported":
      return 0.72;
    case "ai-draft":
      return 0.58;
    case "deprecated":
      return 0.12;
  }
}

function scoreRecency(createdAt: Date | DateTime | string, reference: Date): number {
  const ageMs = Math.max(0, reference.getTime() - toDate(createdAt).getTime());
  const ageDays = ageMs / 86_400_000;
  return 1 / (1 + ageDays / 180);
}

function resourceMatchesFilters(row: ResourceItemRow, filters: ResourceSearchFilters | undefined): boolean {
  if (!filters) return true;
  if (filters.tags?.length) {
    const rowTags = new Set(row.tags.map((tag) => tag.toLowerCase()));
    const wantedTags = filters.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean);
    if (wantedTags.length > 0 && !wantedTags.every((tag) => rowTags.has(tag))) return false;
  }
  if (filters.sourceDomain) {
    if (sourceDomain(row.source_url) !== filters.sourceDomain.trim().toLowerCase()) return false;
  }
  if (filters.dateFrom || filters.dateTo) {
    const created = toDate(row.created_at);
    if (filters.dateFrom && created < new Date(filters.dateFrom)) return false;
    if (filters.dateTo && created > new Date(filters.dateTo)) return false;
  }
  return true;
}

function sourceDomain(sourceUrl: string | undefined): string | undefined {
  if (!sourceUrl) return undefined;
  try {
    return new URL(sourceUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function clampPositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isInteger(value) || (value ?? 0) <= 0) return fallback;
  return value as number;
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

function toDate(value: Date | DateTime | string): Date {
  if (value instanceof DateTime) return value.toDate();
  if (value instanceof Date) return value;
  return new Date(value);
}

function toIso(value: Date | DateTime | string): string {
  return toDate(value).toISOString();
}

export function resourceRowToDTO(row: ResourceItemRow): ResourceDTO {
  return {
    id: String(row.id),
    resourceType: row.resource_type,
    title: row.title,
    summary: row.summary,
    sourceUrl: row.source_url,
    sourceTitle: row.source_title,
    evidence: row.evidence ?? [],
    tags: row.tags ?? [],
    structuredPayload: row.structured_payload ?? {},
    quality: row.quality,
    createdBy: row.created_by ? String(row.created_by) : undefined,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

// ─── 服务 ────────────────────────────────────────────────────────────────────

async function readEmbeddingProfile(session: Surreal): Promise<EmbeddingProfile | null> {
  const results = await session.query<[EmbeddingProfile | null]>(
    "SELECT * FROM ONLY workspace_embedding_profile:default;",
  );
  return results[0] ?? null;
}

async function listResourceRows(session: Surreal, resourceType?: string): Promise<ResourceItemRow[]> {
  if (resourceType) {
    const results = await session.query<[ResourceItemRow[]]>(
      "SELECT * FROM resource_item WHERE resource_type = $resourceType;",
      { resourceType },
    );
    return results[0] ?? [];
  }
  const results = await session.query<[ResourceItemRow[]]>("SELECT * FROM resource_item;");
  return results[0] ?? [];
}

export function createResourceSearchService(deps: ResourceSearchServiceDeps) {
  const now = deps.now ?? (() => new Date());

  /** profile 隔离：只读当前 profile_key 且 status='indexed' 的向量。 */
  async function listIndexedEmbeddings(profileKey: string): Promise<ResourceEmbeddingRow[]> {
    const results = await deps.session.query<[ResourceEmbeddingRow[]]>(
      "SELECT * FROM resource_embedding WHERE profile_key = $profileKey AND status = 'indexed';",
      { profileKey },
    );
    return results[0] ?? [];
  }

  async function inferUnavailableIndexStatus(profileKey: string): Promise<ResourceSearchIndexStatus> {
    const results = await deps.session.query<[Array<Pick<ResourceEmbeddingRow, "status">>]>(
      "SELECT status FROM resource_embedding WHERE profile_key = $profileKey;",
      { profileKey },
    );
    const rows = results[0] ?? [];
    if (rows.some((row) => row.status === "failed")) return "index-error";
    return "index-pending";
  }

  async function buildVectorScores(input: {
    profile: EmbeddingProfile | null;
    queryText: string;
  }): Promise<{ indexStatus: ResourceSearchIndexStatus; scores: Map<string, number> }> {
    if (!input.profile) return { indexStatus: "index-disabled", scores: new Map() };
    const profileKey = createEmbeddingProfileKey(input.profile);
    if (!deps.embeddingProvider) {
      return { indexStatus: await inferUnavailableIndexStatus(profileKey), scores: new Map() };
    }

    try {
      const queryVector = await deps.embeddingProvider.embed({
        text: input.queryText,
        profile: input.profile,
      });
      const embeddings = await listIndexedEmbeddings(profileKey);
      const scores = new Map<string, number>();
      for (const embedding of embeddings) {
        if (!embedding.vector?.length) continue;
        scores.set(String(embedding.resource), cosineSimilarity(queryVector, embedding.vector));
      }
      return {
        indexStatus: scores.size > 0 ? "ready" : await inferUnavailableIndexStatus(profileKey),
        scores,
      };
    } catch {
      return { indexStatus: "index-error", scores: new Map() };
    }
  }

  return {
    async searchResources(req: SearchResourcesRequest): Promise<SearchResourcesResponse> {
      const queryText = buildResourceSearchText(req);
      if (!queryText) throw new Error("检索 query 不能为空");

      const rows = await listResourceRows(deps.session, req.resourceType?.trim() || undefined);
      const profile = await readEmbeddingProfile(deps.session);
      const vectorSearch = await buildVectorScores({ profile, queryText });
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

      return {
        status: ranked.status,
        indexStatus: vectorSearch.indexStatus,
        queryText,
        results: ranked.results.map((item) => ({
          resource: resourceRowToDTO(item.row),
          score: item.score,
          vectorScore: item.vectorScore,
          keywordScore: item.keywordScore,
          qualityScore: item.qualityScore,
          recencyScore: item.recencyScore,
        })),
      };
    },

    async getResourceDetail(req: GetResourceDetailRequest): Promise<ResourceDetailResponse> {
      const results = await deps.session.query<[ResourceItemRow | null]>(
        "SELECT * FROM ONLY $resourceId;",
        { resourceId: new StringRecordId(req.resourceId) },
      );
      const row = results[0];
      if (!row) throw new Error("资源不存在");

      // research_session 关联：created_resources 含此资源的最近一条（PERMISSIONS 已限定可见性）
      const sessionResults = await deps.session.query<[string[]]>(
        "SELECT VALUE <string> id FROM research_session WHERE $resourceId IN created_resources ORDER BY created_at DESC LIMIT 1;",
        { resourceId: new StringRecordId(req.resourceId) },
      );
      const researchSessionId = sessionResults[0]?.[0];

      return {
        resource: {
          ...resourceRowToDTO(row),
          researchSessionId: researchSessionId || undefined,
        },
      };
    },

    async createResearchSession(req: CreateResearchSessionRequest): Promise<ResearchSessionResponse> {
      const query = req.query.trim();
      if (!query) throw new Error("检索问题不能为空");

      const results = await deps.session.query<[ResearchSessionRow | null]>(
        "CREATE ONLY research_session CONTENT $content;",
        {
          content: {
            query,
            context: req.context ?? {},
            resource_type: req.resourceType.trim(),
            status: "open",
            ...(req.originatingRunId?.trim()
              ? { originating_run_id: req.originatingRunId.trim() }
              : {}),
          },
        },
      );
      const row = results[0];
      if (!row) throw new Error("检索会话创建后读取失败");

      return {
        session: {
          id: String(row.id),
          query: row.query,
          context: row.context ?? {},
          resourceType: row.resource_type,
          status: row.status,
          resourceIds: (row.created_resources ?? []).map(String),
          originatingRunId: row.originating_run_id,
          createdAt: toIso(row.created_at),
          updatedAt: toIso(row.updated_at),
        },
      };
    },
  };
}

export type ResourceSearchService = ReturnType<typeof createResourceSearchService>;
// buildDraftEmbeddingText 由保存路径使用；检索查询向量直接用 queryText（与 legacy 行为一致）。
export { buildDraftEmbeddingText };
