import { DateTime } from "surrealdb";
import type {
  ResourceQuality,
  ResourceRow,
  ResourceSearchContext,
  ResourceSearchFilters,
  ResourceSearchStatus,
} from "./resources";

export type ResourceSearchRankedRow = {
  row: ResourceRow;
  score: number;
  vectorScore: number;
  keywordScore: number;
  qualityScore: number;
  recencyScore: number;
};

export type RankResourceSearchRowsRequest = {
  rows: ResourceRow[];
  queryText: string;
  vectorScores: Map<string, number>;
  filters?: ResourceSearchFilters;
  now: Date;
  limit?: number;
  answerThreshold?: number;
  candidateThreshold?: number;
};

export type RankResourceSearchRowsResponse = {
  status: ResourceSearchStatus;
  results: ResourceSearchRankedRow[];
};

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

export function rankResourceSearchRows(req: RankResourceSearchRowsRequest): RankResourceSearchRowsResponse {
  const scoredRows = req.rows
    .filter((row) => resourceMatchesFilters(row, req.filters))
    .map((row) => {
      const keywordScore = scoreKeyword(row, req.queryText);
      const vectorScore = req.vectorScores.get(String(row.id)) ?? 0;
      const qualityScore = scoreQuality(row.quality);
      const recencyScore = scoreRecency(row.created_at, req.now);
      const score = combineResourceScores({ vectorScore, keywordScore, qualityScore, recencyScore });
      return {
        row,
        score,
        vectorScore,
        keywordScore,
        qualityScore,
        recencyScore,
      };
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

function scoreKeyword(row: ResourceRow, queryText: string): number {
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
  const created = createdAt instanceof DateTime ? createdAt.toDate() : new Date(createdAt);
  const ageMs = Math.max(0, reference.getTime() - created.getTime());
  const ageDays = ageMs / 86_400_000;
  return 1 / (1 + ageDays / 180);
}

function combineResourceScores(input: {
  vectorScore: number;
  keywordScore: number;
  qualityScore: number;
  recencyScore: number;
}): number {
  return (
    input.vectorScore * 0.45 +
    input.keywordScore * 0.35 +
    input.qualityScore * 0.12 +
    input.recencyScore * 0.08
  );
}

function resourceMatchesFilters(row: ResourceRow, filters: ResourceSearchFilters | undefined): boolean {
  if (!filters) return true;
  if (filters.tags?.length) {
    const rowTags = new Set(row.tags.map((tag) => tag.toLowerCase()));
    const wantedTags = filters.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean);
    if (wantedTags.length > 0 && !wantedTags.every((tag) => rowTags.has(tag))) return false;
  }
  if (filters.sourceDomain) {
    const domain = sourceDomain(row.source_url);
    if (domain !== filters.sourceDomain.trim().toLowerCase()) return false;
  }
  if (filters.dateFrom || filters.dateTo) {
    const created = new Date(row.created_at instanceof DateTime ? row.created_at.toDate() : row.created_at);
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
