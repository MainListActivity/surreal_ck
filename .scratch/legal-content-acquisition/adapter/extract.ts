/**
 * 确定性抽取层：HTML → 规范化正文与块结构。
 * 全部步骤可复现、无模型参与；清洗规则记录在 cleaningNotes 一并落盘。
 */

export type TextBlock = Readonly<{
  /** 规范化后的块文本（已去首尾空白、收敛空白串）。 */
  text: string;
  /** 块在原始 HTML 中的起点（证据定位用）。 */
  htmlStart: number;
}>;

export const CLEANING_NOTES =
  "NFC 归一；\\r\\n 归一为 \\n；NBSP/全角空格收敛为半角空格；块内连续空白收敛为单个空格；块按块级标签切分、去首尾空白、丢弃空块；块间以 \\n 连接。";

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/giu, " ")
    .replace(/&ensp;/giu, " ")
    .replace(/&emsp;/giu, " ")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)));
}

export function normalizeText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u00a0\u3000\u2002\u2003\u2007\u202f]/gu, " ")
    .replace(/[ \t]+/gu, " ")
    .trim();
}

/** 把 HTML 切成块级文本块（p/div/td/li/h1-h6/tr/table 边界 + <br>），保留原 HTML 偏移。 */
export function htmlToBlocks(html: string): TextBlock[] {
  const withoutInvisible = html
    .replace(/<!--[\s\S]*?-->/gu, (match) => " ".repeat(match.length))
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/giu, (match) => " ".repeat(match.length));
  const blocks: TextBlock[] = [];
  const pattern = /<(?:p|div|td|li|h[1-6]|tr|table)\b[^>]*>/giu;
  const starts: number[] = [];
  for (const match of withoutInvisible.matchAll(pattern)) starts.push(match.index);
  starts.push(withoutInvisible.length);
  for (let index = 0; index < starts.length - 1; index += 1) {
    const start = starts[index];
    const end = starts[index + 1];
    const segment = withoutInvisible.slice(start, end);
    const inner = segment.replace(/<[^>]*>/gu, "\n");
    const text = normalizeText(decodeHtmlEntities(inner));
    if (text.length > 0) blocks.push({ text, htmlStart: start });
  }
  return blocks;
}

export function joinBlocks(blocks: readonly TextBlock[]): string {
  return blocks.map((block) => block.text).join("\n");
}

/** 单行内空白已收敛；跨行换行保留，供条文切分使用。 */
export function collapseBlankLines(text: string): string {
  return text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).join("\n");
}

export function stripHtmlTags(html: string): string {
  return normalizeText(decodeHtmlEntities(html.replace(/<[^>]*>/gu, " ")));
}

/** <title> 文本，去掉站点后缀（_xxx / -xxx / | xxx）。 */
export function pageTitle(html: string): string | null {
  const match = /<title>([\s\S]*?)<\/title>/iu.exec(html);
  if (!match) return null;
  const raw = stripHtmlTags(match[1]);
  const cut = Math.min(
    ...[raw.indexOf("_"), raw.indexOf("-"), raw.indexOf("|")].filter((index) => index > 0).concat([raw.length]),
  );
  return raw.slice(0, cut).trim() || null;
}
