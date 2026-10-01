/**
 * LCA06 授权语料检索：用调用者的 content_reader 会话做关键词 + 结构化召回，
 * 并把"允许进入模型上下文"的片段登记为证据草稿。
 *
 * 授权由内容库在数据库层强制（fn::content_reader_action / content_read_gate），
 * 本模块只做二次校验与登记：AI 使用许可、read/cite 动作、精确版本、定位与哈希。
 * 授权外候选只记 rejected 摘要（版本指针 + 稳定原因码），正文/片段绝不外泄。
 */
import { createHash } from "node:crypto";
import { StringRecordId, type Surreal } from "surrealdb";
import { LegalRetrievalRequestSchema } from "@surreal-ck/shared";
import { retrievePlatformCandidates } from "./platform-retrieval";
import type { EmbeddingProvider } from "../resources/research-save";

type Row = Record<string, unknown>;
type Queryable = Pick<Surreal, "query">;

const rowsOf = (value: unknown): Row[] =>
  (Array.isArray(value) && Array.isArray(value[0]) ? value[0] : []) as Row[];

/** 摘录与引用片段上限：提示词与引用快照都不携带平台全文。 */
export const RESEARCH_QUOTE_MAX_CHARS = 400;

/** 单次研究的证据登记上限（双语料合计），超出部分按 rejected 丢弃。 */
export const RESEARCH_EVIDENCE_LIMIT = 12;

export type PlatformCandidate = {
  versionId: string;
  versionPublicId: string;
  title: string;
  kind: string;
};

export type EvidenceLocator = Readonly<{ start: number; end: number; bodyDigest: string }>;

/**
 * 已通过授权与哈希校验的平台证据。
 * - quoteAllowed=false：read 获准但缺 cite 许可——片段可进模型上下文做分析，
 *   禁止作为引用输出（登记表据此剔除）。
 */
export type PlatformEvidence = Readonly<{
  versionId: string;
  itemId: string;
  versionPublicId: string;
  title: string;
  kind: string;
  sourceKey: string | null;
  sourceUrl: string | null;
  /** 进入模型上下文的片段（≤ RESEARCH_QUOTE_MAX_CHARS）。 */
  quote: string;
  quoteAllowed: boolean;
  locator: EvidenceLocator | null;
  /** 允许片段自身的 sha256（引用快照绑定用）。 */
  quoteSha256: string;
  /** 片段所属版本的正文摘要；与 locator.bodyDigest 交叉核验。 */
  bodySha256: string | null;
}>;

export type RejectionReason =
  | "ai_use_denied"
  | "read_denied"
  | "version_mismatch"
  | "empty_body"
  | "evidence_overflow";

export type RejectedCandidate = Readonly<{ versionPublicId: string; reason: RejectionReason }>;

export type CorpusRetrievalResult = Readonly<{
  evidence: PlatformEvidence[];
  rejected: RejectedCandidate[];
  /** 召回到的候选数（含被拒的），供缺口说明。 */
  candidatesSeen: number;
}>;

async function queryRows(session: Queryable, sql: string, bindings?: Record<string, unknown>): Promise<Row[]> {
  return rowsOf(await session.query(sql, bindings));
}

/** content_read_gate 行 → 生效动作集（gate ∩ license；撤回/停用源在库层已不可见）。 */
function effectiveActions(row: Row): { content: string[]; ai: string[] } | null {
  const versionId = row.version == null ? null : String(row.version);
  if (!versionId) return null;
  const actions = Array.isArray(row.actions) ? row.actions.filter((a): a is string => typeof a === "string") : [];
  const aiActions = Array.isArray(row.ai_actions) ? row.ai_actions.filter((a): a is string => typeof a === "string") : [];
  const license = Array.isArray(row.license_actions)
    ? row.license_actions.filter((a): a is string => typeof a === "string")
    : [];
  const licenseSet = new Set(license);
  return {
    content: actions.filter((action) => licenseSet.has(action)),
    ai: aiActions.filter((action) => licenseSet.has(action)),
  };
}

function aiUseAllowed(ai: readonly string[]): boolean {
  return ai.includes("research") || ai.includes("generate");
}

/** 截断到上限的允许片段；按 Unicode 码点截断，避免代理对撕裂。 */
export function capQuote(text: string, max = RESEARCH_QUOTE_MAX_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return Array.from(trimmed).slice(0, max).join("");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 数字化 locator；FLEXIBLE 对象里的键是 payload 原样（camelCase）。 */
function toLocator(value: unknown): EvidenceLocator | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as { start?: unknown; end?: unknown; bodyDigest?: unknown };
  if (typeof raw.start !== "number" || typeof raw.end !== "number" || typeof raw.bodyDigest !== "string") {
    return null;
  }
  if (!Number.isInteger(raw.start) || !Number.isInteger(raw.end) || raw.start < 0 || raw.end < raw.start) {
    return null;
  }
  return { start: raw.start, end: raw.end, bodyDigest: raw.bodyDigest };
}

/** content_source 表对读者不可见；从 version.source 记录 id（metadata 字段可见）取键。 */
function sourceKeyOf(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value);
  const sep = text.indexOf(":");
  return sep === -1 ? null : text.slice(sep + 1);
}

/**
 * 召回 + 逐候选登记。拒绝决定全部来自数据库可见事实：
 * - 无 AI 使用许可 → ai_use_denied（正文/片段不进入模型上下文）；
 * - 正文字段不可见（无 read）→ read_denied；
 * - locator.bodyDigest ≠ 版本 body_sha256 → version_mismatch（引用必须回到精确版本）；
 * - 无任何片段 → empty_body。
 */
export async function retrieveAuthorizedCorpus(input: {
  session: Queryable;
  query: string;
  limit?: number;
  embeddingProvider?: EmbeddingProvider;
}): Promise<CorpusRetrievalResult> {
  const { session } = input;
  const keyword = input.query.trim().slice(0, 1024);
  if (!keyword) return { evidence: [], rejected: [], candidatesSeen: 0 };
  const limit = input.limit ?? 5;

  // 1) 召回：词项（legalQueryTerms 分词 + 中文 bigram）+ 结构化 facet，配 embedding 时叠加语义召回。
  //    统一走 retrievePlatformCandidates：缺席 embeddingProvider 时自动退化为关键词检索；
  //    ai:true 让库层在召回即按 ai_use 收紧，登记层再做二次校验（fail closed）。
  //    注意不能把整句问题当作单个子串匹配（原 CONTENT_SEARCH_QUERY 路径对自然语言问句必然零召回）。
  const facetRows = (await retrievePlatformCandidates({
    session, embeddingProvider: input.embeddingProvider, ai: true,
    request: LegalRetrievalRequestSchema.parse({ query: keyword, limit: Math.min(20, limit) }),
  })).items.map((hit) => ({ version_id: hit.versionId, public_id: hit.publicId, title: hit.title, kind: hit.kind }));
  const candidates: PlatformCandidate[] = facetRows
    .slice(0, limit)
    .map((row) => ({
      versionId: typeof row.version_id === "string" ? row.version_id : String(row.version_id ?? ""),
      versionPublicId: typeof row.public_id === "string" ? row.public_id : String(row.public_id ?? ""),
      title: typeof row.title === "string" ? row.title : "",
      kind: typeof row.kind === "string" ? row.kind : "",
    }))
    .filter((candidate) => candidate.versionId !== "" && candidate.versionPublicId !== "");

  if (candidates.length === 0) {
    return { evidence: [], rejected: [], candidatesSeen: facetRows.length };
  }

  // 2) 生效动作：读自己的 gate（PERMISSIONS 只放行本 workspace 本 revision 的行）。
  const gateRows = await queryRows(
    session,
    `SELECT version, actions, ai_actions, license_actions FROM content_read_gate WHERE status = "active";`,
  );
  const gates = new Map<string, { content: string[]; ai: string[] }>();
  for (const row of gateRows) {
    const versionId = row.version == null ? null : String(row.version);
    const effective = effectiveActions(row);
    if (versionId && effective) gates.set(versionId, effective);
  }

  const evidence: PlatformEvidence[] = [];
  const rejected: RejectedCandidate[] = [];

  for (const candidate of candidates) {
    if (evidence.length >= RESEARCH_EVIDENCE_LIMIT) {
      rejected.push({ versionPublicId: candidate.versionPublicId, reason: "evidence_overflow" });
      continue;
    }
    const gate = gates.get(candidate.versionId);
    // 召回得到但没有本人 gate 的行不该出现（PERMISSIONS 保障）；出现即 fail closed。
    if (!gate || !aiUseAllowed(gate.ai)) {
      rejected.push({ versionPublicId: candidate.versionPublicId, reason: "ai_use_denied" });
      continue;
    }

    // 3) 版本事实：read 不获准时 body_text 字段在库层不可见（NONE）。
    //    content_source 表对读者不可见，sourceKey 从 source 记录 id 派生。
    const versionRows = await queryRows(
      session,
      `SELECT id, item, public_id, title, version_label, source_url, body_text, body_sha256,
        source, published_on
        FROM content_version WHERE id = $version;`,
      { version: new StringRecordId(candidate.versionId) },
    );
    const version = versionRows[0];
    const bodyText = typeof version?.body_text === "string" ? version.body_text : null;
    if (!version || bodyText === null) {
      rejected.push({ versionPublicId: candidate.versionPublicId, reason: "read_denied" });
      continue;
    }
    const citeAllowed = gate.content.includes("cite");
    const bodySha256 = typeof version.body_sha256 === "string" && version.body_sha256.length > 0
      ? version.body_sha256
      : null;
    if (!bodySha256 || sha256(bodyText) !== bodySha256) {
      rejected.push({ versionPublicId: candidate.versionPublicId, reason: "version_mismatch" });
      continue;
    }

    const registerEvidence = (fragment: {
      quote: string;
      locator: EvidenceLocator | null;
    }): boolean => {
      const quote = capQuote(fragment.quote);
      if (!quote) return false;
      if (fragment.locator && bodySha256 && fragment.locator.bodyDigest !== bodySha256) {
        rejected.push({ versionPublicId: candidate.versionPublicId, reason: "version_mismatch" });
        return false;
      }
      // 结构化片段必须能在这版正文中找到；截断后位置仍准确，不能仅比较摘要字段。
      const preferred = fragment.locator?.start;
      const start = preferred !== undefined && bodyText.slice(preferred, preferred + quote.length) === quote
        ? preferred : bodyText.indexOf(quote);
      if (start < 0) {
        rejected.push({ versionPublicId: candidate.versionPublicId, reason: "version_mismatch" });
        return false;
      }
      evidence.push({
        versionId: candidate.versionId,
        itemId: version.item != null ? String(version.item) : candidate.versionId,
        versionPublicId: typeof version.public_id === "string" ? version.public_id : candidate.versionPublicId,
        title: typeof version.title === "string" && version.title ? version.title : candidate.title,
        kind: candidate.kind,
        sourceKey: sourceKeyOf(version.source),
        sourceUrl: typeof version.source_url === "string" ? version.source_url : null,
        quote,
        quoteAllowed: citeAllowed,
        locator: { start, end: start + quote.length, bodyDigest: bodySha256 },
        quoteSha256: sha256(quote),
        bodySha256,
      });
      return true;
    };

    const registeredBefore = evidence.length;

    // 4a) 法规类内容：按条登记（locator 指向版本正文的精确位置）。
    if (candidate.kind === "legislation") {
      const articleRows = await queryRows(
        session,
        `SELECT local_key, label, body_text, locator FROM legal_article_version WHERE regulation_version = $version;`,
        { version: new StringRecordId(candidate.versionId) },
      );
      for (const article of articleRows) {
        if (evidence.length >= RESEARCH_EVIDENCE_LIMIT) break;
        const articleBody = typeof article.body_text === "string" ? article.body_text : "";
        if (!articleBody.trim()) continue;
        registerEvidence({ quote: articleBody, locator: toLocator(article.locator) });
      }
    }

    // 4b) 裁判文书：引用片段 quoted_text 只有 cite 获准才可见；无结构化引用时走 4c。
    if (candidate.kind === "judicial_document") {
      const citationRows = await queryRows(
        session,
        `SELECT local_citation_key, quoted_text, locator, raw_law_name, raw_article_label
          FROM content_citation WHERE document_version = $version;`,
        { version: new StringRecordId(candidate.versionId) },
      );
      for (const citation of citationRows) {
        if (evidence.length >= RESEARCH_EVIDENCE_LIMIT) break;
        const quoted = typeof citation.quoted_text === "string" ? citation.quoted_text : "";
        if (!quoted.trim()) continue;
        registerEvidence({ quote: quoted, locator: toLocator(citation.locator) });
      }
    }

    // 4c) 两类都没有结构化片段：正文受限摘录兜底（仍然绑定版本哈希）。
    if (evidence.length === registeredBefore) {
      if (!bodyText.trim()) {
        rejected.push({ versionPublicId: candidate.versionPublicId, reason: "empty_body" });
        continue;
      }
      registerEvidence({ quote: bodyText, locator: null });
    }
  }

  return { evidence, rejected, candidatesSeen: candidates.length };
}
