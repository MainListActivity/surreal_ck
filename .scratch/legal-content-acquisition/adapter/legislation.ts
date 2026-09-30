/**
 * 法规详情页适配器（LCAQ-01 准入来源：fgk.chinatax.gov.cn 政策法规库）。
 * 确定性抽取：标题、成文日期、沿革注释（制定机关/版本）、条文切分与编章节层级、施行日期。
 * 页面证据全部落在 document.evidence / sourceLocator；页面没有的字段一律 null + fieldIssues。
 * 注意：locator 偏移是「规范化正文」的 UTF-8 字节偏移；bodyDigest 由 emit 统一填充。
 */

import { utf8ByteLength, type LegalArticle } from "./deps";
import { collapseBlankLines, htmlToBlocks, joinBlocks, normalizeText, stripHtmlTags, type TextBlock } from "./extract";
import { AccessRestrictedError } from "./sources";

export type LegislationExtraction = Readonly<{
  title: string;
  /** 规范化正文（含沿革注释、目录、条文、过渡条款）。 */
  bodyText: string;
  publishedOn: string | null;
  dateText: string | null;
  instrumentType: string | null;
  instrumentTypeEvidence: string | null;
  issuingAuthority: string | null;
  issuingAuthorityEvidence: string | null;
  versionLabel: string | null;
  /** 版本判定依据原文（沿革最后一个修订/修正子句）。 */
  versionEvidence: string | null;
  effectiveOn: string | null;
  effectiveEvidence: string | null;
  /** locator.bodyDigest 由 emit 填充；此处为空串占位。 */
  articles: LegalArticle[];
  /** 页面类型判定依据；不是法规详情页时抛 AccessRestrictedError。 */
  pageTypeEvidence: string;
}>;

const ARTICLE_LINE = /^第[一二三四五六七八九十百千零]+条/u;
const CHAPTER_LINE = /^第[一二三四五六七八九十百千零]+(编|章|节)/u;
/** 正文终结符：只认页面尾部的导航/署名块；收藏/分享/订阅是页首工具栏按钮，不是终结符。 */
const TAIL_MARKER = /^(上一篇|下一篇|责任编辑|相关政策|相关文档|友情链接|网站地图|主办单位|打印本页)/u;

const CN_DIGIT: Readonly<Record<string, number>> = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 中文数字（〇零一二三四五六七八九十百千）→ 阿拉伯数字；支持 二十四 / 二百六十六 / 一百零四。 */
export function chineseNumberToInteger(input: string): number | null {
  const text = input.trim();
  if (!/^[〇零一二三四五六七八九十百千]+$/u.test(text)) return null;
  const unitIndex = ["千", "百", "十"].map((unit) => text.indexOf(unit)).find((index) => index >= 0);
  if (unitIndex === undefined) {
    let sum = 0;
    for (const char of text) {
      if (char === "〇" || char === "零") continue;
      sum += CN_DIGIT[char];
    }
    return sum;
  }
  const unit = text[unitIndex];
  if (unit !== "千" && unit !== "百" && unit !== "十") return null;
  const unitValue: number = { 千: 1000, 百: 100, 十: 10 }[unit];
  const base = unitIndex === 0 ? 1 : chineseNumberToInteger(text.slice(0, unitIndex));
  const rest = text.slice(unitIndex + 1);
  if (base === null) return null;
  return base * unitValue + (rest.length > 0 ? (chineseNumberToInteger(rest) ?? NaN) : 0) || null;
}

const CN_YEAR_DIGIT: Readonly<Record<string, string>> = { 〇: "0", 零: "0", 一: "1", 二: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" };

/** 落款日期（如 二〇二四年一月二十四日）→ 2024-01-24。 */
export function chineseDateToIsoDate(input: string): string | null {
  const match = /^([〇零一二三四五六七八九]{4})年([一二三四五六七八九十]{1,3})月([一二三四五六七八九十]{1,3})日$/u.exec(input.trim());
  if (!match) return null;
  const year = [...match[1]].map((char) => CN_YEAR_DIGIT[char]).join("");
  const month = chineseNumberToInteger(match[2]);
  const day = chineseNumberToInteger(match[3]);
  if (year.length !== 4 || month === null || day === null || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** 「2024年7月1日」→ 2024-07-01；解析失败返回 null。 */
export function cnFullDateToIsoDate(input: string): string | null {
  const match = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/u.exec(input.trim());
  if (!match) return null;
  const iso = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  return Number.isFinite(new Date(`${iso}T00:00:00Z`).getTime()) ? iso : null;
}

function extractBreadcrumbSegment(html: string): { instrumentType: string | null; evidence: string | null } {
  const raw = stripHtmlTags(html).match(/当前位置[：:]\s*首页\s*>\s*政策法规\s*>\s*([^>\n]+)/u);
  if (!raw) return { instrumentType: null, evidence: null };
  const segment = normalizeText(raw[1]);
  return { instrumentType: segment.length > 0 ? segment : null, evidence: normalizeText(raw[0]) };
}

function extractRevisionNote(blocks: readonly TextBlock[]): string | null {
  for (const block of blocks) {
    if (/通过/.test(block.text) && /(修正|修订)/.test(block.text) && /会议/.test(block.text)) return block.text;
  }
  return null;
}

/** 从沿革注释取最后一个修订/修正子句（当前版本的判定依据）。 */
export function latestRevisionClause(revisionNote: string): string | null {
  const clauses = revisionNote.split(/\s+(?=根据|\d{4}年)/u).map((part) => part.trim()).filter(Boolean);
  return clauses.filter((clause) => /(修订|修正)/.test(clause) && /\d{4}年/.test(clause)).at(-1) ?? null;
}

function buildArticles(
  bodyText: string,
  bodyBlocks: readonly TextBlock[],
  effectiveOn: string | null,
): LegalArticle[] {
  const lines = bodyText.split("\n");
  const blockIndexOfLine: number[] = [];
  bodyBlocks.forEach((block, blockIndex) => {
    for (let line = 0; line < block.text.split("\n").length; line += 1) blockIndexOfLine.push(blockIndex);
  });

  // 先收集编/章/节标题行与条文起始行。
  type Heading = { line: number; label: string };
  const headings: Heading[] = [];
  const articleStarts: number[] = [];
  lines.forEach((line, lineIndex) => {
    const chapterMatch = CHAPTER_LINE.exec(line);
    if (chapterMatch && line.length <= 40) {
      headings.push({ line: lineIndex, label: chapterMatch[0].trim() });
      return;
    }
    if (ARTICLE_LINE.test(line) && line.length <= 2000) articleStarts.push(lineIndex);
  });

  // 条文文本区间：从本条起始行到下一「条文/标题」行之前。
  const boundaries = [...headings.map((heading) => heading.line), ...articleStarts, lines.length].sort((a, b) => a - b);
  const articles: LegalArticle[] = [];
  for (const [order, startLine] of articleStarts.entries()) {
    const endLine = (boundaries.find((line) => line > startLine) ?? lines.length) - 1;
    const bodyTextOfArticle = lines.slice(startLine, endLine + 1).join("\n").trim();
    if (bodyTextOfArticle.length === 0) continue;
    const start = startLine === 0 ? 0 : utf8ByteLength(`${lines.slice(0, startLine).join("\n")}\n`);
    const end = startLine === 0 ? utf8ByteLength(lines.slice(0, endLine + 1).join("\n")) : utf8ByteLength(`${lines.slice(0, endLine + 1).join("\n")}`);
    const levels: Record<string, string> = {};
    for (const heading of headings) {
      if (heading.line >= startLine) break;
      const kind = heading.label.match(/^第[一二三四五六七八九十百千零]+(编|章|节)/u)![1];
      if (kind === "编") { levels["编"] = heading.label; delete levels["章"]; delete levels["节"]; }
      else if (kind === "章") { levels["章"] = heading.label; delete levels["节"]; }
      else levels["节"] = heading.label;
    }
    articles.push({
      localKey: `article-${order + 1}`,
      label: lines[startLine].match(ARTICLE_LINE)![0],
      hierarchyPath: ["编", "章", "节"].flatMap((kind) => (levels[kind] ? [levels[kind]] : [])),
      bodyText: bodyTextOfArticle,
      locator: { start, end, bodyDigest: "" },
      sourceLocator: { paragraph: (blockIndexOfLine[startLine] ?? 0) + 1, articleLabel: lines[startLine].match(ARTICLE_LINE)![0] },
      effectiveOn,
    });
  }
  return articles;
}

export function extractLegislationPage(input: Readonly<{ html: string; url: string }>): LegislationExtraction {
  const blocks = htmlToBlocks(input.html);
  if (blocks.length < 3) throw new AccessRestrictedError("页面块数过少，疑似非详情页或访问受限");
  const metaIndex = blocks.findIndex((block) => block.text.includes("成文日期"));
  if (metaIndex < 0) {
    throw new AccessRestrictedError("页面缺少「成文日期」元信息，疑似非法规详情页，停止抽取");
  }
  const breadcrumb = extractBreadcrumbSegment(input.html);
  // 终止于最后一个页面尾块（上一篇/责任编辑等）；工具栏按钮不算。
  let tailIndex = -1;
  for (const [index, block] of blocks.entries()) {
    if (index > metaIndex && TAIL_MARKER.test(block.text)) tailIndex = index;
  }
  const bodyBlocks = blocks.slice(metaIndex + 1, tailIndex < 0 ? blocks.length : tailIndex);
  if (bodyBlocks.length === 0) throw new AccessRestrictedError("元信息之后没有正文块，疑似非法规详情页");
  const bodyText = collapseBlankLines(joinBlocks(bodyBlocks));
  if (!/第[一二三四五六七八九十百千零]+条/u.test(bodyText)) {
    throw new AccessRestrictedError("正文没有条文（第X条），疑似列表页/摘要页，拒绝按详情页抽取");
  }
  const metaText = blocks[metaIndex].text;
  const dateMatch = /成文日期[：:]\s*(\d{4}-\d{2}-\d{2})/u.exec(metaText);
  const publishedOn = dateMatch ? dateMatch[1] : null;
  const revisionNote = extractRevisionNote(bodyBlocks);
  const latestClause = revisionNote ? latestRevisionClause(revisionNote) : null;
  const issuingAuthority = revisionNote && /全国人民代表大会常务委员会/.test(revisionNote) ? "全国人民代表大会常务委员会" : null;
  const effectiveMatch = /本法自\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*起施行/u.exec(bodyText);
  const effectiveOn = effectiveMatch ? cnFullDateToIsoDate(`${effectiveMatch[1]}年${effectiveMatch[2]}月${effectiveMatch[3]}日`) : null;
  // 标题优先取正文标题元素（h1/h2/h3），<title> 常为空或含站点名。
  const headingTitle = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/iu.exec(input.html)?.[1];
  const title = stripHtmlTags(headingTitle ?? /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(input.html)?.[1] ?? "");
  return {
    title: title.length > 0 ? title : bodyBlocks[0].text,
    bodyText,
    publishedOn,
    dateText: publishedOn ? `成文日期：${publishedOn}` : null,
    instrumentType: breadcrumb.instrumentType,
    instrumentTypeEvidence: breadcrumb.evidence,
    issuingAuthority,
    issuingAuthorityEvidence: revisionNote,
    versionLabel: latestClause,
    versionEvidence: latestClause,
    effectiveOn,
    effectiveEvidence: effectiveMatch ? effectiveMatch[0] : null,
    articles: buildArticles(bodyText, bodyBlocks, effectiveOn),
    pageTypeEvidence: `页面含「成文日期」元信息与「第X条」条文；正文 ${bodyText.length} 字`,
  };
}
