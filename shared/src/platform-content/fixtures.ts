import type { IngestionBatch } from "./contracts";
import { sha256Hex, utf8ByteLength } from "./validation";

export const SYNTHETIC_SOURCE_KEY = "fixture.synthetic.cn";

/** 一整份合成法规，仅用于独立库发布与引用关系验收。 */
export async function createSyntheticLegislationBatch(): Promise<IngestionBatch> {
  const articleText = "第四百条 本合成规范仅用于数据库迁移测试。";
  const bodyText = `【合成法规】平台内容验收规范\n${articleText}`;
  const start = utf8ByteLength(bodyText.slice(0, bodyText.indexOf(articleText)));
  const bodySha256 = await sha256Hex(bodyText);
  return {
    contractVersion: "1",
    idempotencyKey: "fixture-synthetic-legislation-v1",
    items: [{
      entryKey: "fixture-legislation-1",
      operation: "upsert",
      payload: {
        kind: "legislation",
        source: {
          sourceKey: SYNTHETIC_SOURCE_KEY,
          url: "https://example.invalid/fixture/law-1",
          recordKey: "law-1",
          fetchedAt: "2026-09-01T12:00:00Z",
          publishedAt: null,
          updatedAt: null,
          publishedOn: "2026-09-01",
          updatedOn: null,
          dateText: null,
        },
        document: {
          title: "合同法",
          bodyText,
          sourceForm: "full_text",
          evidence: [{ text: "合成来源，仅用于协议边界测试。", sourceLocator: { paragraph: 1 } }],
          fieldIssues: [],
          processing: {
            pipelineVersion: "fixture-v1",
            methods: ["synthetic-fixture"],
            agentName: null,
            model: null,
            cleaningNotes: "不代表任何真实法规。",
          },
          clientDigest: { bodySha256 },
        },
        legislation: {
          issuingAuthorities: ["合成测试机关"],
          instrumentType: "规范性文件",
          documentNumber: "(fixture) law-1",
          promulgatedOn: "2026-09-01",
          effectiveOn: "2026-09-01",
          repealedOn: null,
          legalStatus: "effective",
          versionLabel: "fixture-v1",
          versionResolution: "resolved",
          amendsRefs: [],
          articles: [{
            localKey: "article-1",
            label: "第四百条",
            hierarchyPath: ["第一章"],
            bodyText: articleText,
            locator: { start, end: start + utf8ByteLength(articleText), bodyDigest: bodySha256 },
            sourceLocator: { paragraph: 1, articleLabel: "第四百条" },
            effectiveOn: "2026-09-01",
          }],
        },
      },
    }],
  };
}

/**
 * 仅供契约测试使用的完整合成文书。它明确标记为 synthetic，不能当作官方来源发布。
 */
export async function createSyntheticJudgmentBatch(): Promise<IngestionBatch> {
  const bodyText =
    "【合成全文】本院经审理查明：当事人行为时有效的《合同法》第四百条规定，受托人应当报告处理委托事务的情况。" +
    "本院认为，争议应依照证据和适用时点判断。判决如下：驳回全部诉讼请求。";
  const quotedText = "当事人行为时有效的《合同法》第四百条规定";
  const start = utf8ByteLength(bodyText.slice(0, bodyText.indexOf(quotedText)));
  const end = start + utf8ByteLength(quotedText);
  const bodySha256 = await sha256Hex(bodyText);
  return {
    contractVersion: "1",
    idempotencyKey: "fixture-synthetic-judgment-v1",
    items: [
      {
        entryKey: "fixture-judgment-1",
        operation: "upsert",
        payload: {
          kind: "judicial_document",
          source: {
            sourceKey: SYNTHETIC_SOURCE_KEY,
            url: "https://example.invalid/fixture/judgment-1",
            recordKey: "judgment-1",
            fetchedAt: "2026-09-01T12:00:00Z",
            publishedAt: null,
            updatedAt: null,
            publishedOn: "2026-09-01",
            updatedOn: null,
            dateText: null,
          },
          document: {
            title: "合成民事判决书（契约测试）",
            bodyText,
            sourceForm: "full_text",
            evidence: [{ text: "合成来源，仅用于协议边界测试。", sourceLocator: null }],
            fieldIssues: [],
            processing: {
              pipelineVersion: "fixture-v1",
              methods: ["synthetic-fixture"],
              agentName: null,
              model: null,
              cleaningNotes: "不代表任何真实裁判文书。",
            },
            clientDigest: { bodySha256 },
          },
          judgment: {
            documentType: "民事判决书",
            caseNumber: "(fixture) synthetic-1",
            court: "合成测试法院",
            decidedOn: "2026-09-01",
            causeOfAction: "合同纠纷",
            instance: "一审",
            procedure: "普通程序",
            outcome: { disposition: "驳回全部诉讼请求", evidenceRef: null },
            citationExtractionStatus: "processed_complete",
            citations: [
              {
                localCitationKey: "citation-1",
                relationKind: "explicit_citation",
                speaker: "court",
                quotedText,
                locator: { start, end, bodyDigest: bodySha256, sourceLocator: null },
                rawLawName: "合同法",
                rawArticleLabel: "第四百条",
                resolution: "unresolved",
                candidates: [],
                treatment: "discusses",
                treatmentEvidence: "本院认为，争议应依照证据和适用时点判断。",
              },
            ],
          },
        },
      },
    ],
  };
}

/** 官方公开样本的可追溯元数据；正文未内嵌，避免把未授权快照误当成可销售内容。 */
export const OFFICIAL_SAMPLE_METADATA = {
  sourceKey: "cicc.public.judgment",
  url: "https://cicc.court.gov.cn/html/1/218/180/316/12572.html",
  caseNumber: "(2022)最高法商初7号",
  documentType: "民事判决书",
  decidedOn: "2024-01-24",
  pagePublishedOn: "2024-09-04",
  evidenceStatus: "official_html_read_without_local_snapshot",
  bodyIncluded: false,
} as const;
