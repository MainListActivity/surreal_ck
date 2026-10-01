import { z } from "zod";

/** Ranking changes require a new version; publication date is never a relevance boost. */
export const LEGAL_RANKING_VERSION = "legal-rrf-v1";
export const LEGAL_CANDIDATE_LIMIT = 40;
export const LegalRetrievalRequestSchema = z.strictObject({
  query: z.string().trim().min(1).max(1024),
  mode: z.enum(["hybrid", "keyword"]).default("hybrid"),
  kind: z.enum(["all", "legislation", "judicial_document"]).default("all"),
  jurisdiction: z.string().trim().max(100).default(""),
  procedure: z.string().trim().max(256).default(""),
  issue: z.string().trim().max(256).default(""),
  effectiveOn: z.string().max(10).default(""),
  publishedFrom: z.string().max(10).default(""),
  publishedUntil: z.string().max(10).default(""),
  limit: z.number().int().min(1).max(20).default(10),
});
export type LegalRetrievalRequest = z.infer<typeof LegalRetrievalRequestSchema>;
export type LegalRetrievalHit = {
  versionId: string; publicId: string; itemId: string; title: string; kind: string;
  revision: number; versionLabel: string | null; sourceUrl: string; bodySha256: string;
  jurisdiction: string | null; effectiveOn: string | null;
  score: number; explanation: string[];
  /** Identical text is collapsed, but independently citable source versions survive here. */
  sources: Array<{ versionId: string; publicId: string; sourceUrl: string }>;
};
export type LegalRetrievalResponse = {
  items: LegalRetrievalHit[];
  capability: "hybrid" | "keyword";
  notice: string;
  rankingVersion: string;
  indexVersion: string | null;
};

/** No candidate cache: every request reruns current database PERMISSIONS. */
export function legalRetrievalIdentity(input: {
  workspace: string; revision: string; release: string; embedding: string;
}): string {
  return JSON.stringify([input.workspace, input.revision, input.release, input.embedding, LEGAL_RANKING_VERSION]);
}

/** Fixed segmentation, including Chinese bigrams, is shared by baseline and hybrid. */
export function legalQueryTerms(query: string): string[] {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const result = new Set<string>();
  for (const term of terms) {
    result.add(term);
    if (/^[\p{Script=Han}]+$/u.test(term)) {
      const chars = Array.from(term);
      for (let i = 0; i + 1 < chars.length; i++) result.add(chars.slice(i, i + 2).join(""));
    }
  }
  return [...result].slice(0, 64);
}

export type LegalRankCandidate = {
  hit: Omit<LegalRetrievalHit, "score" | "explanation" | "sources">;
  keyword: number;
  semanticRank?: number;
  authority: number;
  quality: number;
  procedure: string;
  issue: string;
};

/** Reciprocal rank fusion: distances from different profiles/corpora are never compared. */
export function rankLegalCandidates(candidates: LegalRankCandidate[], req: LegalRetrievalRequest): LegalRetrievalHit[] {
  const keywordOrder = [...candidates].filter((c) => c.keyword > 0)
    .sort((a, b) => b.keyword - a.keyword || a.hit.versionId.localeCompare(b.hit.versionId));
  const keywords = new Map(keywordOrder.map((c, i) => [c.hit.versionId, i + 1]));
  const ranked = candidates.map((candidate) => {
    const keywordRank = keywords.get(candidate.hit.versionId);
    const semanticRank = candidate.semanticRank;
    const explanation: string[] = [];
    let score = 0;
    if (keywordRank) { score += 1 / (20 + keywordRank); explanation.push("关键词匹配"); }
    if (semanticRank) { score += 1 / (20 + semanticRank); explanation.push("语义相关"); }
    // Small documented tie-break signals cannot create matches in their own right.
    score += Math.min(1, Math.max(0, candidate.authority)) * 0.002;
    score += Math.min(1, Math.max(0, candidate.quality)) * 0.001;
    if (candidate.authority > 0) explanation.push("法源或裁判层级");
    if (candidate.quality > 0) explanation.push("来源质量信号");
    if (req.jurisdiction && candidate.hit.jurisdiction === req.jurisdiction) explanation.push("法域匹配");
    if (req.procedure && candidate.procedure === req.procedure) explanation.push("程序匹配");
    if (req.issue && candidate.issue.includes(req.issue)) explanation.push("争点匹配");
    if (req.effectiveOn && candidate.hit.effectiveOn === req.effectiveOn) explanation.push("效力日期匹配");
    return { candidate, score, explanation };
  }).filter(({ candidate }) => keywords.has(candidate.hit.versionId) || candidate.semanticRank !== undefined)
    .sort((a, b) => b.score - a.score || a.candidate.hit.versionId.localeCompare(b.candidate.hit.versionId));
  const byIdentity = new Map<string, LegalRetrievalHit>();
  for (const { candidate, score, explanation } of ranked) {
    const h = candidate.hit;
    const identity = h.bodySha256 ? `${h.kind}:${h.bodySha256}` : h.itemId;
    const source = { versionId: h.versionId, publicId: h.publicId, sourceUrl: h.sourceUrl };
    const existing = byIdentity.get(identity);
    if (existing) {
      if (!existing.sources.some((s) => s.versionId === h.versionId)) existing.sources.push(source);
    } else byIdentity.set(identity, { ...h, score, explanation, sources: [source] });
  }
  return [...byIdentity.values()].slice(0, req.limit);
}
