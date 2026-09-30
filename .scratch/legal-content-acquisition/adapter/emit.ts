/**
 * 成品装配：把适配器抽取结果转成 platform-content v1 IngestionBatch，
 * 并在本地用与 MCP 服务端完全相同的校验器（validatePlatformContentBatch）复核；
 * 校验失败按 entryKey + fieldPath 返回，本地可定位。
 */

import {
  PLATFORM_CONTENT_CONTRACT_VERSION,
  validatePlatformContentBatch,
  sha256Hex,
  type FieldIssue,
  type IngestionBatch,
  type IngestionEntry,
  type UpsertContentPayload,
  type LegalArticle,
  type LegislationMetadata,
  type JudgmentMetadata,
  type DocumentEvidence,
  type PlatformContentValidationIssue,
} from "./deps";

type UpsertEntry = Extract<IngestionEntry, { operation: "upsert" }>;
import type { LegislationExtraction } from "./legislation";
import type { JudgmentExtraction } from "./judgment";
import { QUALIFIED_SOURCES } from "./sources";

const PIPELINE_VERSION = "lcaq02-adapter-v1";
/** 采集方法名单：当前全部为确定性步骤，无模型建议（model=null）。 */
const DETERMINISTIC_METHODS = ["deterministic-html-extraction"] as const;

type CommonExtracted = Readonly<{
  title: string;
  bodyText: string;
  sourceKey: string;
  url: string;
  recordKey: string;
  fetchedAt: string;
  publishedOn: string | null;
  dateText: string | null;
}>;

function issue(path: string, message: string, code: FieldIssue["code"] = "unknown"): FieldIssue {
  return { path, code, severity: "warning", message };
}

function buildEvidence(entries: readonly (readonly [string, Record<string, unknown> | null])[]): DocumentEvidence[] {
  return entries
    .filter(([text]) => text.trim().length > 0)
    .map(([text, sourceLocator]) => ({ text, sourceLocator: sourceLocator ?? null }));
}

function withArticleDigests(articles: readonly LegalArticle[], bodyDigest: string): LegalArticle[] {
  return articles.map((article) => ({
    ...article,
    locator: { start: article.locator?.start ?? 0, end: article.locator?.end ?? 0, bodyDigest },
  }));
}

export async function buildLegislationEntry(input: {
  extracted: LegislationExtraction;
  sourceKey: string;
  url: string;
  recordKey: string;
  fetchedAt: string;
  entryKey: string;
}): Promise<UpsertEntry> {
  const { extracted } = input;
  const bodyDigest = await sha256Hex(extracted.bodyText);
  const articles = withArticleDigests(extracted.articles, bodyDigest);
  const fieldIssues: FieldIssue[] = [];
  if (!extracted.issuingAuthority) fieldIssues.push(issue("legislation.issuingAuthorities", "页面未标注制定机关，沿革注释缺失或不含可识别机关名"));
  if (!extracted.instrumentType) fieldIssues.push(issue("legislation.instrumentType", "页面栏目/面包屑未标注文件类别"));
  if (!extracted.issuingAuthorityEvidence) fieldIssues.push(issue("legislation.documentNumber", "页面未提供发文字号"));
  if (!extracted.effectiveOn) fieldIssues.push(issue("legislation.effectiveOn", "正文未找到「本法自X年X月X日起施行」条款"));
  if (extracted.publishedOn && !extracted.versionLabel) fieldIssues.push(issue("legislation.versionLabel", "页面沿革缺失，无法判定版本归属"));
  if (extracted.publishedOn) {
    fieldIssues.push(issue("legislation.promulgatedOn", "页面仅提供成文日期，公布日期未单列；promulgatedOn 以成文日期填充，精度以证据为准"));
  }
  const legislation: LegislationMetadata = {
    issuingAuthorities: extracted.issuingAuthority ? [extracted.issuingAuthority] : null,
    instrumentType: extracted.instrumentType,
    documentNumber: null,
    promulgatedOn: extracted.publishedOn,
    effectiveOn: extracted.effectiveOn,
    repealedOn: null,
    legalStatus: extracted.effectiveOn && extracted.effectiveOn <= new Date().toISOString().slice(0, 10) ? "effective" : "unknown",
    versionLabel: extracted.versionLabel,
    versionResolution: extracted.versionLabel ? "resolved" : "unresolved",
    amendsRefs: [],
    articles: extracted.articles,
  };
  return {
    entryKey: input.entryKey,
    operation: "upsert",
    payload: {
      kind: "legislation",
      source: {
        sourceKey: input.sourceKey,
        url: input.url,
        recordKey: input.recordKey,
        fetchedAt: input.fetchedAt,
        publishedAt: null,
        updatedAt: null,
        publishedOn: extracted.publishedOn,
        updatedOn: null,
        dateText: extracted.dateText,
      },
      document: {
        title: extracted.title,
        bodyText: extracted.bodyText,
        // 完整性由适配器判定：条文 + 施行条款同时在场才允许 full_text（emit.run 校验）。
        sourceForm: "full_text",
        evidence: buildEvidence([
          [extracted.dateText ?? "", { text: extracted.dateText ?? undefined }],
          [extracted.instrumentTypeEvidence ?? "", extracted.instrumentTypeEvidence ? { text: extracted.instrumentTypeEvidence } : null],
          [extracted.issuingAuthorityEvidence ?? "", extracted.issuingAuthorityEvidence ? { text: extracted.issuingAuthorityEvidence.slice(0, 512) } : null],
          [extracted.effectiveEvidence ?? "", extracted.effectiveEvidence ? { articleLabel: extracted.articles.at(-1)?.label ?? null } : null],
        ]),
        fieldIssues,
        processing: {
          pipelineVersion: PIPELINE_VERSION,
          methods: [...DETERMINISTIC_METHODS],
          agentName: "lcaq02-local-adapter",
          model: null,
          cleaningNotes: "条文/沿革/目录按页面块序原样保留；空白清洗规则见 cleaningNotes 常量（extract.ts）。",
        },
        clientDigest: { bodySha256: bodyDigest },
      },
      // bodyDigest 在本函数开头计算；条文定位与 clientDigest 绑定同一摘要。
      legislation: { ...legislation, articles },
    },
  };
}

export async function buildJudgmentEntry(input: {
  extracted: JudgmentExtraction;
  sourceKey: string;
  url: string;
  recordKey: string;
  fetchedAt: string;
  entryKey: string;
}): Promise<UpsertEntry> {
  const { extracted } = input;
  const bodyDigest = await sha256Hex(extracted.bodyText);
  const citations = extracted.citations.map((citation) => ({ ...citation, locator: { ...citation.locator, bodyDigest } }));
  const fieldIssues: FieldIssue[] = [];
  if (!extracted.documentType) fieldIssues.push(issue("judgment.documentType", "页面没有可识别的文书类型标头"));
  if (!extracted.causeOfAction) fieldIssues.push(issue("judgment.causeOfAction", "标题未提供案由"));
  if (!extracted.outcomeDisposition) fieldIssues.push(issue("judgment.outcome", "正文未找到「判决如下/裁定如下」主文段"));
  fieldIssues.push(issue("judgment.instance", "页面未标注审级，拒绝推断"));
  fieldIssues.push(issue("judgment.procedure", "页面未标注审理程序，拒绝推断"));
  const judgment: JudgmentMetadata = {
    documentType: extracted.documentType,
    caseNumber: extracted.caseNumber,
    court: extracted.court,
    decidedOn: extracted.decidedOn,
    causeOfAction: extracted.causeOfAction,
    instance: null,
    procedure: null,
    outcome: extracted.outcomeDisposition
      ? { disposition: extracted.outcomeDisposition, evidenceRef: null }
      : null,
    citationExtractionStatus: extracted.citationExtractionStatus,
    citations,
  };
  return {
    entryKey: input.entryKey,
    operation: "upsert",
    payload: {
      kind: "judicial_document",
      source: {
        sourceKey: input.sourceKey,
        url: input.url,
        recordKey: input.recordKey,
        fetchedAt: input.fetchedAt,
        publishedAt: null,
        updatedAt: null,
        publishedOn: null,
        updatedOn: null,
        dateText: extracted.decidedEvidence,
      },
      document: {
        title: extracted.title,
        bodyText: extracted.bodyText,
        sourceForm: "full_text",
        evidence: buildEvidence([
          [extracted.documentTypeEvidence ?? "", { text: extracted.documentTypeEvidence ?? undefined }],
          [extracted.decidedEvidence ?? "", { text: extracted.decidedEvidence ?? undefined }],
        ]),
        fieldIssues,
        processing: {
          pipelineVersion: PIPELINE_VERSION,
          methods: [...DETERMINISTIC_METHODS],
          agentName: "lcaq02-local-adapter",
          model: null,
          cleaningNotes: "文书头/正文/落款按页面块序原样保留；空白清洗规则见 extract.ts CLEANING_NOTES。",
        },
        clientDigest: { bodySha256: bodyDigest },
      },
      judgment,
    },
  };
}

/** 本地校验：与 MCP 服务端同一 validatePlatformContentBatch；失败按 entryKey+fieldPath 归位。 */
export async function validateBatch(batch: IngestionBatch): Promise<
  { ok: true; bodyDigests: Record<string, string> } | { ok: false; issues: PlatformContentValidationIssue[] }
> {
  const result = await validatePlatformContentBatch(batch);
  if (result.ok) return { ok: true, bodyDigests: result.bodyDigests };
  return { ok: false, issues: result.issues };
}

/** 页面正文是否具备 full_text 资格（法规：施行条款在场）。完整性不满足时降级 excerpt。 */
export function assertFullTextLegislation(extracted: LegislationExtraction): boolean {
  return extracted.articles.length > 0 && extracted.effectiveEvidence !== null;
}

export { QUALIFIED_SOURCES };
