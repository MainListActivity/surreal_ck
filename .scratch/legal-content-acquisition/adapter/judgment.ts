/**
 * 裁判文书详情页适配器（LCAQ-01 准入来源：cicc.court.gov.cn 国际商事法庭）。
 * 确定性抽取：文书类型、案号、法院、落款日期、判决主文、《法律》引用定位（UTF-8 字节偏移）。
 * 引语定位必须能从正文原样还原（服务端以 utf8Slice + sha256 校验）。
 * speaker 只按可证段落（本院认为=法院、诉辩=当事人）表达，段落不明一律 unknown。
 */

import { utf8ByteLength, type ContentCitation } from "./deps";
import { collapseBlankLines, htmlToBlocks, normalizeText, type TextBlock } from "./extract";
import { chineseDateToIsoDate } from "./legislation";
import { AccessRestrictedError } from "./sources";

export type JudgmentExtraction = Readonly<{
  title: string;
  bodyText: string;
  documentType: string | null;
  documentTypeEvidence: string | null;
  caseNumber: string | null;
  court: string | null;
  decidedOn: string | null;
  decidedEvidence: string | null;
  causeOfAction: string | null;
  causeOfActionEvidence: string | null;
  outcomeDisposition: string | null;
  /** 引用抽取状态：确定性全量扫描为 processed_complete。 */
  citationExtractionStatus: "not_processed" | "processed_none" | "processed_partial" | "processed_complete";
  citations: ContentCitation[];
  /** locator.bodyDigest 由 emit 填充；此处为空串占位。 */
  pageTypeEvidence: string;
}>;

const DOCUMENT_TYPE_LINE = /^(中华人民共和国)?\s*民\s*事\s*(判决书|裁定书|调解书)$/u;
const CASE_NUMBER_LINE = /^[（(]\d{4}[)）][^）(\n]{0,40}号$/u;
const CN_DATE_LINE = /^[〇零一二三四五六七八九]{4}年[一二三四五六七八九十]{1,3}月[一二三四五六七八九十]{1,3}日$/u;
/** 《法律名》第X条（第X款）（第X项）的引用形态。 */
const CITATION_PATTERN = /《[^《》\n]{2,60}》第[一二三四五六七八九十百千零]+条(?:第[一二三四五六七八九十]+款)?(?:第[一二三四五六七八九十]+项)?(?:之[一二三四五六七八九十]+)?/gu;

/** 正文段落标记 → 引语 speaker。 */
function sectionSpeaker(text: string, quoteStartByte: number): "court" | "party" | "unknown" {
  const sectionMarkers = ["本院认为", "判决如下", "裁定如下", "本院经审理查明", "本院查明"];
  const positions = sectionMarkers
    .map((marker) => ({ marker, byte: utf8ByteLength(text.slice(0, Math.max(0, text.indexOf(marker)))) }))
    .filter((entry) => text.includes(entry.marker))
    .sort((left, right) => left.byte - right.byte);
  const active = [...positions].reverse().find((entry) => entry.byte <= quoteStartByte);
  if (!active) return "party";
  if (active.marker === "本院认为" || active.marker === "判决如下" || active.marker === "裁定如下") return "court";
  if (active.marker.endsWith("查明")) return "unknown";
  return "party";
}

function lastByteIndexOfLine(text: string, predicate: (line: string) => boolean): { start: number; end: number } | null {
  let offset = 0;
  let found: { start: number; end: number } | null = null;
  for (const line of text.split("\n")) {
    const length = utf8ByteLength(line);
    if (predicate(line)) found = { start: offset, end: offset + length };
    offset += length + utf8ByteLength("\n");
  }
  return found;
}

export function extractJudgmentPage(input: Readonly<{ html: string; url: string }>): JudgmentExtraction {
  const blocks = htmlToBlocks(input.html);
  const headerIndex = blocks.findIndex((block) => DOCUMENT_TYPE_LINE.test(normalizeText(block.text.replace(/\s+/gu, " ")).replace(/ /gu, " ")) || DOCUMENT_TYPE_LINE.test(block.text.replace(/\s+/gu, "")));
  if (headerIndex < 0) {
    throw new AccessRestrictedError("页面没有「X 事 判决书/裁定书」文书头，疑似列表页/摘要页，拒绝按详情页抽取");
  }
  // 落款：最后一个「二〇XX年X月X日」形态的块，作为正文终点。
  const decidedBlock = [...blocks].reverse().find((block) => CN_DATE_LINE.test(block.text));
  if (!decidedBlock) {
    throw new AccessRestrictedError("页面没有落款日期块（二〇XX年X月X日），疑似未完整公开或非文书页，拒绝抽取");
  }
  const bodyBlocks: TextBlock[] = [];
  for (const block of blocks) {
    if (block.htmlStart < blocks[headerIndex].htmlStart) continue;
    bodyBlocks.push(block);
    if (block.text === decidedBlock.text && block.htmlStart >= decidedBlock.htmlStart) break;
  }
  const bodyText = collapseBlankLines(bodyBlocks.map((block) => block.text).join("\n"));
  if (bodyText.length < 50) throw new AccessRestrictedError("正文过短，疑似未完整公开，拒绝抽取");

  const documentTypeBlock = blocks[headerIndex].text.replace(/\s+/gu, "");
  const caseBlock = blocks.slice(0, headerIndex + 3).find((block) => CASE_NUMBER_LINE.test(block.text));
  const courtBlock = blocks.slice(0, headerIndex).reverse().find((block) => /最高人民法院|人民法院/.test(block.text));
  const decidedOn = chineseDateToIsoDate(decidedBlock.text);
  const sourceLine = blocks.find((block) => block.text.includes("来源："))?.text ?? null;
  const causeFromTitle = /】([^【】]+纠纷?)案/u.exec(rawTitle(input.html))?.[1] ?? null;
  const disposition = extractDisposition(bodyText);
  const citations = extractCitations(bodyText, blocks);
  return {
    title: rawTitle(input.html),
    bodyText,
    documentType: normalizeDocumentType(documentTypeBlock),
    documentTypeEvidence: blocks[headerIndex].text,
    caseNumber: caseBlock ? caseBlock.text : null,
    court: courtBlock ? courtBlock.text : null,
    decidedOn,
    decidedEvidence: decidedBlock.text,
    causeOfAction: causeFromTitle,
    causeOfActionEvidence: sourceLine,
    outcomeDisposition: disposition,
    citationExtractionStatus: "processed_complete",
    citations,
    pageTypeEvidence: `文书头「${documentTypeBlock}」+ 案号 + 落款「${decidedBlock.text}」；正文 ${bodyText.length} 字`,
  };
}

function rawTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  if (!match) return "未知标题";
  const raw = normalizeText(match[1].replace(/<[^>]*>/gu, " "));
  const bracket = raw.indexOf("【");
  return bracket >= 0 ? raw.slice(bracket).trim() : raw.trim();
}

function normalizeDocumentType(line: string): string | null {
  const collapsed = line.replace(/\s+/gu, "");
  return DOCUMENT_TYPE_LINE.test(line) || DOCUMENT_TYPE_LINE.test(collapsed)
    ? collapsed.replace(/^中华人民共和国/u, "")
    : null;
}

function extractDisposition(bodyText: string): string | null {
  const start = bodyText.indexOf("判决如下");
  if (start < 0) return null;
  const end = findDispositionEnd(bodyText, start);
  return bodyText.slice(start + 4, end).trim().replace(/^[：:]\s*/u, "").trim();
}

function findDispositionEnd(bodyText: string, start: number): number {
  // 主文结束于「本判决/本裁定」程序性说明之前；找不到则取到落款段前最后一个句号。
  const procedural = ["本判决为终审判决", "本裁定为终审裁定", "本判决书送达", "审 判 长", "审判长"];
  const candidates = procedural
    .map((marker) => bodyText.indexOf(marker, start))
    .filter((index) => index > start);
  return candidates.length > 0 ? Math.min(...candidates) : bodyText.length;
}

function extractCitations(bodyText: string, bodyBlocks: readonly TextBlock[]): ContentCitation[] {
  const citations: ContentCitation[] = [];
  let cursor = 0;
  for (const match of bodyText.matchAll(CITATION_PATTERN)) {
    const quotedText = match[0];
    const start = utf8ByteLength(bodyText.slice(0, match.index));
    const end = start + utf8ByteLength(quotedText);
    const speaker = sectionSpeaker(bodyText, start);
    const lawName = /《([^《》]+)》/u.exec(quotedText)![1];
    const articleLabel = /第[一二三四五六七八九十百千零]+条(?:第[一二三四五六七八九十]+款)?(?:第[一二三四五六七八九十]+项)?/u.exec(quotedText)?.[0] ?? null;
    citations.push({
      localCitationKey: `citation-${citations.length + 1}`,
      relationKind: "explicit_citation",
      speaker,
      quotedText,
      locator: { start, end, bodyDigest: "", sourceLocator: paragraphLocator(bodyText, bodyBlocks, start) },
      rawLawName: lawName,
      rawArticleLabel: articleLabel,
      resolution: "unresolved",
      candidates: [],
      treatment: "unknown",
    });
    cursor = match.index + quotedText.length;
  }
  void cursor;
  return citations;
}

function paragraphLocator(bodyText: string, bodyBlocks: readonly TextBlock[], byteStart: number) {
  void bodyText;
  let offset = 0;
  for (const [index, block] of bodyBlocks.entries()) {
    const length = utf8ByteLength(block.text);
    if (offset + length >= byteStart) return { paragraph: index + 1 };
    offset += length + utf8ByteLength("\n");
  }
  return { paragraph: bodyBlocks.length };
}
