import { StringRecordId } from "surrealdb";
import type { ContentCitation, SearchContentItem } from "@surreal-ck/shared/platform-content";
import { toStringRecordId } from "../db/surreal-values";

type Queryable = {
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

type Row = Record<string, unknown>;

export type CitationResolutionCandidate = Readonly<{
  itemId: string;
  versionId: string;
  articleId: null;
}>;

export type CitationResolutionOverlay = Readonly<{
  versionId: string;
  localCitationKey: string;
  status: ContentCitation["resolution"];
  candidates: CitationResolutionCandidate[];
}>;

export type LegislationVersionReference = Readonly<{
  recordId: StringRecordId;
  itemId: string;
  versionId: string;
  title: string;
  versionResolution: string | null;
  effectiveOn: string | null;
}>;

export type LegalArticleReference = Readonly<{
  recordId: StringRecordId;
  versionRecordId: StringRecordId;
  label: string;
}>;

export type CitationReference = Readonly<{
  recordId: StringRecordId;
  localCitationKey: string;
  relationKind: "explicit_citation" | "inferred_relation";
  rawLawName: string | null;
  rawArticleLabel: string | null;
  decidedOn: string | null;
}>;

export type PlannedCitationResolution = Readonly<{
  citation: CitationReference;
  status: "ambiguous" | "proposed" | "verified";
  candidates: CitationResolutionCandidate[];
  matches: ReadonlyArray<Readonly<{
    legislation: LegislationVersionReference;
    article: LegalArticleReference | null;
  }>>;
  evidenceRef: string;
}>;

type CitationMatch = Readonly<{
  legislation: LegislationVersionReference;
  article: LegalArticleReference | null;
}>;

export type CitationResolutionReconcileResult = Readonly<{
  scanned: number;
  verified: number;
  proposed: number;
  ambiguous: number;
  unchanged: number;
}>;

function rows(result: unknown): Row[] {
  if (!Array.isArray(result) || !Array.isArray(result[0])) return [];
  return result[0].filter((value): value is Row => typeof value === "object" && value !== null && !Array.isArray(value));
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function object(value: unknown): Row | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : null;
}

function recordId(value: unknown, table: string): StringRecordId | null {
  const id = toStringRecordId(value);
  return id?.toString().startsWith(`${table}:`) ? id : null;
}

export function normalizeLawTitle(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[《》〈〉\s]/gu, "")
    .trim();
}

export function baseArticleLabel(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.normalize("NFKC").replace(/\s/gu, "");
  return normalized.match(/第[〇零一二三四五六七八九十百千万两0-9]+条/u)?.[0] ?? null;
}

function candidateKey(candidate: CitationResolutionCandidate): string {
  return `${candidate.itemId}\u0000${candidate.versionId}\u0000${candidate.articleId ?? ""}`;
}

function sameCandidates(left: readonly CitationResolutionCandidate[], right: readonly CitationResolutionCandidate[]): boolean {
  return left.map(candidateKey).sort().join("\u0001") === right.map(candidateKey).sort().join("\u0001");
}

/**
 * 精确名称与条号匹配只生成候选。只有版本元数据已 resolved，且裁判日期能唯一落入
 * 某一生效版本时，才自动标记 verified；否则保持可审计的 proposed / ambiguous。
 */
export function planCitationResolutions(input: Readonly<{
  citations: readonly CitationReference[];
  legislation: readonly LegislationVersionReference[];
  articles: readonly LegalArticleReference[];
}>): PlannedCitationResolution[] {
  const legislationByTitle = new Map<string, LegislationVersionReference[]>();
  for (const version of input.legislation) {
    const key = normalizeLawTitle(version.title);
    const list = legislationByTitle.get(key) ?? [];
    list.push(version);
    legislationByTitle.set(key, list);
  }
  const articlesByVersionAndLabel = new Map<string, LegalArticleReference[]>();
  for (const article of input.articles) {
    const key = `${article.versionRecordId.toString()}\u0000${baseArticleLabel(article.label) ?? article.label}`;
    const list = articlesByVersionAndLabel.get(key) ?? [];
    list.push(article);
    articlesByVersionAndLabel.set(key, list);
  }

  const plans: PlannedCitationResolution[] = [];
  for (const citation of input.citations) {
    if (citation.relationKind !== "explicit_citation" || !citation.rawLawName) continue;
    const articleLabel = baseArticleLabel(citation.rawArticleLabel);
    const titleMatches = legislationByTitle.get(normalizeLawTitle(citation.rawLawName)) ?? [];
    const matches: CitationMatch[] = [];
    for (const version of titleMatches) {
      if (!articleLabel) {
        matches.push({ legislation: version, article: null });
        continue;
      }
      const articleMatches = articlesByVersionAndLabel.get(`${version.recordId.toString()}\u0000${articleLabel}`) ?? [];
      for (const matchedArticle of articleMatches) matches.push({ legislation: version, article: matchedArticle });
    }
    if (matches.length === 0) continue;

    const candidates = matches.map(({ legislation }) => ({
      itemId: legislation.itemId,
      versionId: legislation.versionId,
      articleId: null,
    } satisfies CitationResolutionCandidate));
    const uniqueCandidates = [...new Map(candidates.map((candidate) => [candidateKey(candidate), candidate])).values()];

    let selected = matches;
    if (citation.decidedOn) {
      const effective = matches
        .filter(({ legislation }) => legislation.effectiveOn && legislation.effectiveOn <= citation.decidedOn!)
        .sort((a, b) => (b.legislation.effectiveOn ?? "").localeCompare(a.legislation.effectiveOn ?? ""));
      if (effective.length > 0) {
        const latestDate = effective[0]!.legislation.effectiveOn;
        selected = effective.filter(({ legislation }) => legislation.effectiveOn === latestDate);
      }
    }

    const canVerify = selected.length === 1
      && Boolean(citation.decidedOn)
      && selected[0]!.legislation.versionResolution === "resolved"
      && Boolean(selected[0]!.legislation.effectiveOn)
      && selected[0]!.legislation.effectiveOn! <= citation.decidedOn!;
    const status = canVerify ? "verified" : uniqueCandidates.length === 1 ? "proposed" : "ambiguous";
    const resolvedMatches = canVerify ? selected : matches;
    const resolvedCandidates = canVerify
      ? [{
        itemId: selected[0]!.legislation.itemId,
        versionId: selected[0]!.legislation.versionId,
        articleId: null,
      }]
      : uniqueCandidates;
    plans.push({
      citation,
      status,
      candidates: resolvedCandidates,
      matches: resolvedMatches,
      evidenceRef: canVerify
        ? "exact-title-article-and-effective-date:v1"
        : "exact-title-and-article-candidate:v1",
    });
  }
  return plans;
}

export function applyCitationResolutionOverlays<T extends SearchContentItem>(
  items: readonly T[],
  overlays: readonly CitationResolutionOverlay[],
): T[] {
  const byCitation = new Map(overlays.map((overlay) => [
    `${overlay.versionId}\u0000${overlay.localCitationKey}`,
    overlay,
  ]));
  return items.map((item) => {
    if (!item.judgment?.citations) return item;
    return {
      ...item,
      judgment: {
        ...item.judgment,
        citations: item.judgment.citations.map((citation) => {
          const overlay = byCitation.get(`${item.version.versionId}\u0000${citation.localCitationKey}`);
          return overlay ? { ...citation, resolution: overlay.status, candidates: overlay.candidates } : citation;
        }),
      },
    };
  });
}

function parseLegislation(rowsInput: readonly Row[]): LegislationVersionReference[] {
  return rowsInput.flatMap((row) => {
    const id = recordId(row.id, "content_version");
    const item = object(row.item);
    const itemId = text(item?.public_id);
    const versionId = text(row.public_id);
    const title = text(row.title);
    if (!id || !itemId || !versionId || !title) return [];
    return [{
      recordId: id,
      itemId,
      versionId,
      title,
      versionResolution: text(row.version_resolution),
      effectiveOn: text(row.effective_on),
    }];
  });
}

function parseArticles(rowsInput: readonly Row[]): LegalArticleReference[] {
  return rowsInput.flatMap((row) => {
    const id = recordId(row.id, "legal_article_version");
    const versionRecordId = recordId(row.regulation_version, "content_version");
    const label = text(row.label);
    return id && versionRecordId && label ? [{ recordId: id, versionRecordId, label }] : [];
  });
}

function parseCitations(rowsInput: readonly Row[]): CitationReference[] {
  return rowsInput.flatMap((row) => {
    const id = recordId(row.id, "content_citation");
    const documentVersion = object(row.document_version);
    const item = object(documentVersion?.item);
    const payload = object(documentVersion?.content_kind_payload);
    const judgment = object(payload?.judgment);
    const relationKind = row.relation_kind;
    const isCurrent = recordId(item?.current_version, "content_version")?.toString() === recordId(documentVersion?.id, "content_version")?.toString();
    if (!id || !isCurrent || item?.publication_status !== "published" || (relationKind !== "explicit_citation" && relationKind !== "inferred_relation")) return [];
    const localCitationKey = text(row.local_citation_key);
    if (!localCitationKey) return [];
    return [{
      recordId: id,
      localCitationKey,
      relationKind,
      rawLawName: text(row.raw_law_name),
      rawArticleLabel: text(row.raw_article_label),
      decidedOn: text(judgment?.decidedOn),
    }];
  });
}

function latestResolutionByCitation(rowsInput: readonly Row[]): Map<string, Readonly<{
  status: ContentCitation["resolution"];
  candidates: CitationResolutionCandidate[];
  revision: number;
}>> {
  const result = new Map<string, { status: ContentCitation["resolution"]; candidates: CitationResolutionCandidate[]; revision: number }>();
  for (const row of rowsInput) {
    const citation = recordId(row.citation, "content_citation")?.toString();
    const revision = typeof row.revision === "number" ? row.revision : Number(row.revision);
    const status = row.status;
    if (!citation || !Number.isSafeInteger(revision) || !["unresolved", "ambiguous", "proposed", "verified"].includes(String(status))) continue;
    const current = result.get(citation);
    if (current && current.revision >= revision) continue;
    const candidates = Array.isArray(row.candidates)
      ? row.candidates.flatMap((candidate) => {
        const value = object(candidate);
        const itemId = text(value?.itemId);
        const versionId = text(value?.versionId);
        return itemId && versionId ? [{ itemId, versionId, articleId: null as null }] : [];
      })
      : [];
    result.set(citation, { status: status as ContentCitation["resolution"], candidates, revision });
  }
  return result;
}

async function persistPlans(
  db: Queryable,
  plans: readonly PlannedCitationResolution[],
  latest: ReadonlyMap<string, Readonly<{ status: ContentCitation["resolution"]; candidates: CitationResolutionCandidate[]; revision: number }>>,
  actorSubject: string,
): Promise<{ verified: number; proposed: number; ambiguous: number; unchanged: number }> {
  let verified = 0;
  let proposed = 0;
  let ambiguous = 0;
  let unchanged = 0;
  for (const plan of plans) {
    const current = latest.get(plan.citation.recordId.toString());
    if (current?.status === plan.status && sameCandidates(current.candidates, plan.candidates)) {
      unchanged += 1;
      continue;
    }
    const resolution = new StringRecordId(`citation_resolution:${crypto.randomUUID().replaceAll("-", "")}`);
    const revision = (current?.revision ?? 0) + 1;
    const statements = [
      "BEGIN TRANSACTION;",
      "CREATE $resolution CONTENT { citation: $citation, revision: $revision, status: $status, candidates: $candidates, evidence_ref: $evidenceRef, verified_by_subject: IF $status = \"verified\" THEN $actorSubject ELSE NONE END, created_at: time::now() };",
    ];
    const distinctMatches = [...new Map(plan.matches.map((match) => [
      `${match.legislation.recordId.toString()}\u0000${match.article?.recordId.toString() ?? ""}`,
      match,
    ])).values()];
    const relationParams: Record<string, unknown> = {};
    distinctMatches.forEach((match, index) => {
      relationParams[`legislation_${index}`] = match.legislation.recordId;
      statements.push(`RELATE $citation->cites_legislation->$legislation_${index} SET resolution_revision = $resolution;`);
      if (match.article) {
        relationParams[`article_${index}`] = match.article.recordId;
        statements.push(`RELATE $citation->cites_article->$article_${index} SET resolution_revision = $resolution;`);
      }
    });
    statements.push("COMMIT TRANSACTION;");
    await db.query(statements.join("\n"), {
      resolution,
      citation: plan.citation.recordId,
      revision,
      status: plan.status,
      candidates: plan.candidates,
      evidenceRef: plan.evidenceRef,
      actorSubject,
      ...relationParams,
    });
    if (plan.status === "verified") verified += 1;
    else if (plan.status === "proposed") proposed += 1;
    else ambiguous += 1;
  }
  return { verified, proposed, ambiguous, unchanged };
}

export async function reconcileCitationResolutions(
  db: Queryable,
  actorSubject = "system:citation-resolver",
): Promise<CitationResolutionReconcileResult> {
  const [legislationResult, articleResult, citationResult, resolutionResult] = await Promise.all([
    db.query(`SELECT id, public_id, title,
      content_kind_payload.legislation.versionResolution AS version_resolution,
      content_kind_payload.legislation.effectiveOn AS effective_on,
      item
      FROM content_version
      WHERE item.kind = "legislation" AND item.publication_status = "published"
      FETCH item;`),
    db.query("SELECT id, regulation_version, label FROM legal_article_version;"),
    db.query(`SELECT id, document_version, local_citation_key, relation_kind, raw_law_name, raw_article_label
      FROM content_citation FETCH document_version, document_version.item;`),
    db.query("SELECT citation, revision, status, candidates FROM citation_resolution ORDER BY revision DESC;"),
  ]);
  const citations = parseCitations(rows(citationResult));
  const latest = latestResolutionByCitation(rows(resolutionResult));
  const plans = planCitationResolutions({
    citations,
    legislation: parseLegislation(rows(legislationResult)),
    articles: parseArticles(rows(articleResult)),
  });
  const persisted = await persistPlans(db, plans, latest, actorSubject);
  return { scanned: citations.length, ...persisted };
}

export async function loadCitationResolutionOverlays(
  db: Queryable,
  versionIds: readonly string[],
): Promise<CitationResolutionOverlay[]> {
  if (versionIds.length === 0) return [];
  const citationResult = await db.query(
    `SELECT id, document_version, local_citation_key FROM content_citation
     WHERE document_version IN (SELECT VALUE id FROM content_version WHERE public_id IN $versionIds)
     FETCH document_version;`,
    { versionIds },
  );
  const citationRows = rows(citationResult);
  const citationIds = citationRows.flatMap((row) => {
    const id = recordId(row.id, "content_citation");
    return id ? [id] : [];
  });
  if (citationIds.length === 0) return [];
  const resolutionResult = await db.query(
    "SELECT citation, revision, status, candidates FROM citation_resolution WHERE citation IN $citationIds ORDER BY revision DESC;",
    { citationIds },
  );
  const latest = latestResolutionByCitation(rows(resolutionResult));
  return citationRows.flatMap((row) => {
    const citationId = recordId(row.id, "content_citation")?.toString();
    const documentVersion = object(row.document_version);
    const versionId = text(documentVersion?.public_id);
    const localCitationKey = text(row.local_citation_key);
    const resolution = citationId ? latest.get(citationId) : null;
    return versionId && localCitationKey && resolution
      ? [{ versionId, localCitationKey, status: resolution.status, candidates: resolution.candidates }]
      : [];
  });
}
