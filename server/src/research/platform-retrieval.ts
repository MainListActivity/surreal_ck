import { StringRecordId, type Surreal } from "surrealdb";
import {
  LEGAL_CANDIDATE_LIMIT, LEGAL_RANKING_VERSION, legalQueryTerms, rankLegalCandidates,
  type LegalRankCandidate, type LegalRetrievalRequest, type LegalRetrievalResponse,
} from "@surreal-ck/shared";
import { createEmbeddingProfileKey, type EmbeddingProfile, type EmbeddingProvider } from "../resources/research-save";

type Queryable = Pick<Surreal, "query">;
type Row = Record<string, unknown>;
export type PlatformEmbeddingProfile = EmbeddingProfile & { release: string };
export const PLATFORM_PROFILE_QUERY = "SELECT * FROM ONLY content_embedding_profile:default;";
const FILTERS = `($kind = 'all' OR kind = $kind)
 AND ($jurisdiction = '' OR jurisdiction = $jurisdiction)
 AND ($procedure = '' OR procedure = $procedure)
 AND ($issue = '' OR issue CONTAINS $issue)
 AND ($effectiveOn = '' OR effective_on = $effectiveOn)
 AND ($publishedFrom = '' OR published_on >= $publishedFrom)
 AND ($publishedUntil = '' OR published_on <= $publishedUntil)
 AND (!$ai OR fn::content_reader_action(version.id, 'ai_use'))`;
const FIELDS = `version.id AS version_id, version.public_id AS public_id, item AS item_id,
 version.title AS title, version.revision AS revision, version.version_label AS version_label,
 version.source_url AS source_url, version.body_sha256 AS body_sha256,
 kind, jurisdiction, effective_on, procedure, issue, authority, quality`;
// FETCH version：每行一次权限解析，字段级 PERMISSIONS（body_text 需 read）照常生效；
// 之后 version.* 为内存字段读取，不再逐字段重复鉴权。lt/lb 为预计算小写文本。
const FETCHED_FACETS = `(SELECT *,
 string::lowercase(version.title ?? '') AS lt,
 string::lowercase(version.body_text ?? '') AS lb
 FROM content_search_facet FETCH version)`;
export const PLATFORM_KEYWORD_QUERY = `SELECT ${FIELDS},
 array::len(array::filter($terms, |$t| lt CONTAINS $t OR lb CONTAINS $t)) AS keyword_score
 FROM ${FETCHED_FACETS} WHERE ${FILTERS}
 AND array::any($terms, |$t| lt CONTAINS $t OR lb CONTAINS $t)
 ORDER BY keyword_score DESC, version_id ASC LIMIT 40 TIMEOUT 2s;`;

// HNSW is not relied upon for recall under cross-collection permissions. The exact
// complement below applies PERMISSIONS and profile/release filtering inside the DB.
export const PLATFORM_HNSW_QUERY = `SELECT version, vector::distance::knn() AS distance
 FROM content_search_embedding WHERE vector <|40, 80|> $vector
 AND profile_key = $profileKey AND release = $release
 AND body_sha256 = version.body_sha256
 AND (!$ai OR fn::content_reader_action(version, 'ai_use')) LIMIT 40 TIMEOUT 2s;`;
export const PLATFORM_EXACT_QUERY = `SELECT version, (1 - vector::similarity::cosine(vector, $vector)) AS distance
 FROM content_search_embedding WHERE profile_key = $profileKey AND release = $release
 AND body_sha256 = version.body_sha256
 AND (!$ai OR fn::content_reader_action(version, 'ai_use'))
 ORDER BY distance ASC, version ASC LIMIT 40 TIMEOUT 2s;`;
export const PLATFORM_SEMANTIC_FACETS_QUERY = `SELECT ${FIELDS}, 0 AS keyword_score
 FROM ${FETCHED_FACETS} WHERE version.id IN $versions AND ${FILTERS} LIMIT 40 TIMEOUT 2s;`;

function rows(value: unknown): Row[] {
  return Array.isArray(value) && Array.isArray(value[0]) ? value[0] as Row[] : [];
}
const str = (value: unknown): string => value == null ? "" : String(value);
const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;

export async function readPlatformEmbeddingProfile(session: Queryable): Promise<PlatformEmbeddingProfile | null> {
  const result = await session.query(PLATFORM_PROFILE_QUERY);
  const row = Array.isArray(result) ? result[0] : null;
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const p = row as Row;
  if (typeof p.provider !== "string" || typeof p.model !== "string" || p.dimensions !== 1536
    || typeof p.version !== "string" || typeof p.release !== "string") return null;
  return {
    provider: p.provider, model: p.model, dimensions: 1536, version: p.version, release: p.release,
    ...(typeof p.base_url === "string" ? { base_url: p.base_url } : {}),
    ...(p.api_format === "openai-compatible" ? { api_format: p.api_format } : {}),
  };
}

export function validEmbedding(vector: number[], dimensions: number): boolean {
  return vector.length === dimensions && vector.every(Number.isFinite) && vector.some((v) => v !== 0);
}

function candidate(row: Row): LegalRankCandidate | null {
  if (!row.version_id || !row.public_id || !row.title || !row.source_url) return null;
  return {
    hit: {
      versionId: str(row.version_id), publicId: str(row.public_id), itemId: str(row.item_id),
      title: str(row.title), kind: str(row.kind), revision: num(row.revision),
      versionLabel: row.version_label == null ? null : str(row.version_label), sourceUrl: str(row.source_url),
      bodySha256: str(row.body_sha256), jurisdiction: row.jurisdiction == null ? null : str(row.jurisdiction),
      effectiveOn: row.effective_on == null ? null : str(row.effective_on),
    },
    keyword: num(row.keyword_score), authority: num(row.authority), quality: num(row.quality),
    procedure: str(row.procedure), issue: str(row.issue),
  };
}

/** Narrow caller-bound adapter; no collection/workspace identity can be supplied by the model. */
export async function retrievePlatformCandidates(input: {
  session: Queryable; request: LegalRetrievalRequest; embeddingProvider?: EmbeddingProvider; ai?: boolean;
}): Promise<LegalRetrievalResponse> {
  const { session, request } = input;
  const bindings = { ...request, terms: legalQueryTerms(request.query), ai: input.ai ?? false };
  const keywordRows = rows(await session.query(PLATFORM_KEYWORD_QUERY, bindings));
  const candidates = new Map<string, LegalRankCandidate>();
  for (const row of keywordRows) {
    const c = candidate(row);
    if (c) candidates.set(c.hit.versionId, c);
  }
  let capability: LegalRetrievalResponse["capability"] = "keyword";
  let indexVersion: string | null = null;
  let notice = request.mode === "keyword" ? "关键词与结构化检索。" : "语义索引未就绪，已使用同一授权范围内的关键词与结构化检索。";
  if (request.mode === "hybrid" && input.embeddingProvider) {
    try {
      const profile = await readPlatformEmbeddingProfile(session);
      if (profile) {
        const vector = await input.embeddingProvider.embed({ text: request.query, profile });
        if (!validEmbedding(vector, profile.dimensions)) throw new Error("invalid-embedding");
        const vars = { ...bindings, vector, profileKey: createEmbeddingProfileKey(profile), release: profile.release };
        // Approximation failure does not broaden authorization; exact DB search is the recall fallback.
        await session.query(PLATFORM_HNSW_QUERY, vars).catch(() => undefined);
        const exact = rows(await session.query(PLATFORM_EXACT_QUERY, vars));
        const ordered = exact.filter((row) => typeof row.distance === "number" && Number.isFinite(row.distance));
        const ranks = new Map(ordered.map((row, i) => [str(row.version), i + 1]));
        if (ordered.length > 0) {
          const facets = rows(await session.query(PLATFORM_SEMANTIC_FACETS_QUERY, {
            ...bindings, versions: ordered.map((row) => new StringRecordId(str(row.version))),
          }));
          for (const row of facets) {
            const c = candidate(row);
            if (!c) continue;
            const existing = candidates.get(c.hit.versionId) ?? c;
            existing.semanticRank = ranks.get(c.hit.versionId);
            candidates.set(c.hit.versionId, existing);
          }
          capability = "hybrid";
          indexVersion = JSON.stringify([vars.profileKey, profile.release]);
          notice = "关键词与语义混合检索；排序解释仅说明相关性，不构成结论性意见。";
        }
      }
    } catch {
      notice = "语义服务或索引暂不可用，已降级到同一授权范围内的关键词与结构化检索。";
    }
  }
  const items = rankLegalCandidates([...candidates.values()], request);
  if (items.length < Math.min(3, request.limit)) notice += " 当前授权范围内召回较少，可调整问题或筛选条件。";
  return { items, capability, notice, rankingVersion: LEGAL_RANKING_VERSION, indexVersion };
}

export { LEGAL_CANDIDATE_LIMIT };
