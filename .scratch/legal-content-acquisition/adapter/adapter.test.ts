/**
 * LCAQ-02 适配器测试（全部使用合成页面 fixture，明确非真实样本）。
 * 覆盖：条文切分与层级、UTF-8 字节偏移还原、重复引文、空白清洗、
 * 非详情页拒绝、缺失语义字段的 fieldIssues 映射、批次与服务端校验器对齐。
 *
 * 运行：bun test ./.scratch/legal-content-acquisition/adapter/adapter.test.ts
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { utf8Slice, sha256Hex, validatePlatformContentBatch, type IngestionBatch, type LegalArticle, type CitationSpeakerSchema } from "./deps";
import { chineseDateToIsoDate, chineseNumberToInteger, extractLegislationPage, latestRevisionClause } from "./legislation";
import { extractJudgmentPage } from "./judgment";
import { buildJudgmentEntry, buildLegislationEntry, validateBatch } from "./emit";
import { parseRobotsDisallowAll, isPathDisallowed } from "./http";
import { requireQualifiedSource, AccessRestrictedError } from "./sources";

const fixtureDir = join(import.meta.dir, "test-fixtures");

async function loadFixture(name: string): Promise<string> {
  return readFile(join(fixtureDir, name), "utf8");
}

const FGK_URL = "https://fgk.chinatax.gov.cn/zcfgk/c100009/c5233383/content.html";
const CICC_URL = "https://cicc.court.gov.cn/html/1/218/180/316/12572.html";
const FETCHED_AT = "2026-09-30T08:00:00.000Z";

/** LegalArticle.locator 在契约里可选；本适配器保证总是填充，测试里用它收窄。 */
function articleLocator(article: LegalArticle) {
  if (!article.locator) throw new Error(`条文 ${article.label} 缺少定位`);
  return article.locator;
}

type SpeakerCounts = Record<"court" | "party" | "unknown", number>;

describe("中文数字与日期", () => {
  test("中文数字解析（含二十四、二百六十六、一百零四）", () => {
    expect(chineseNumberToInteger("二十四")).toBe(24);
    expect(chineseNumberToInteger("二百六十六")).toBe(266);
    expect(chineseNumberToInteger("一百零四")).toBe(104);
    expect(chineseNumberToInteger("十")).toBe(10);
    expect(chineseNumberToInteger("〇")).toBe(0);
    expect(chineseNumberToInteger("abc")).toBeNull();
  });
  test("落款中文日期 → ISO 日历日期", () => {
    expect(chineseDateToIsoDate("二〇二四年一月二十四日")).toBe("2024-01-24");
    expect(chineseDateToIsoDate("二〇二六年一月一日")).toBe("2026-01-01");
    expect(chineseDateToIsoDate("2024年1月24日")).toBeNull();
  });
  test("沿革最后子句", () => {
    const note = "1999年1月1日测试会议通过 根据2025年1月1日测试会议《决定》第一次修正 2026年1月1日测试会议第二次修订";
    expect(latestRevisionClause(note)).toContain("第二次修订");
  });
});

describe("法规页适配器（合成 fgk 形态页面）", () => {
  test("条文切分、层级与 UTF-8 字节偏移可还原", async () => {
    const html = await loadFixture("fgk-content-page.html");
    const extracted = extractLegislationPage({ html, url: FGK_URL });
    expect(extracted.articles.map((article) => article.label)).toEqual(["第一条", "第二条", "第三条"]);
    expect(extracted.articles.every((article) => article.hierarchyPath.length > 0)).toBe(true);
    expect(extracted.effectiveOn).toBe("2026-02-01");
    expect(extracted.publishedOn).toBe("2026-01-01");
    expect(extracted.versionLabel).toContain("第二次修订");
    // 合成页注释不含全国人大常委会 → 机关未知，由 emit 阶段 fieldIssues 说明。
    expect(extracted.issuingAuthority).toBeNull();
    for (const article of extracted.articles) {
      const locator = articleLocator(article);
      const restored = utf8Slice(extracted.bodyText, locator.start, locator.end);
      expect(restored).toBe(article.bodyText);
    }
  });

  test("清洗规则：NBSP/全角空格/CRLF 收敛后定位仍精确", async () => {
    const html = "<html><body><div>当前位置： 首页 > 政策法规 > 法律</div><div>成文日期：2026-01-01</div>" +
      "<p>第一条&nbsp;&nbsp;多字节「引号」与书名号《书名号》，\r\n另起一行仍在同条。</p><p>第二条 本法自 2026 年 3 月 1 日 起施行。</p><div>上一篇</div></body></html>";
    const extracted = extractLegislationPage({ html, url: FGK_URL });
    expect(extracted.bodyText).not.toMatch(/\r|\u00a0|\u3000/u);
    expect(extracted.articles).toHaveLength(2);
    for (const article of extracted.articles) {
      const locator = articleLocator(article);
      expect(utf8Slice(extracted.bodyText, locator.start, locator.end)).toBe(article.bodyText);
    }
    expect(extracted.effectiveOn).toBe("2026-03-01");
  });

  test("装配批次通过服务端同款校验器；未知机关带 fieldIssues", async () => {
    const html = await loadFixture("fgk-content-page.html");
    const extracted = extractLegislationPage({ html, url: FGK_URL });
    const entry = await buildLegislationEntry({ extracted, sourceKey: "fgk.chinatax.gov.cn", url: FGK_URL, recordKey: "c5233383", fetchedAt: FETCHED_AT, entryKey: "test-entry-legislation-1" });
    const batch: IngestionBatch = { contractVersion: "1", idempotencyKey: "lcaq02-test-legislation", items: [entry] };
    const result = await validatePlatformContentBatch(batch);
    if (!result.ok) console.error(result.issues);
    expect(result.ok).toBe(true);
    const payload = batch.items[0].operation === "upsert" ? batch.items[0].payload : null;
    expect(payload?.kind === "legislation" && payload.legislation.issuingAuthorities === null).toBe(true);
    expect(payload?.document.fieldIssues.some((issue) => issue.path === "legislation.issuingAuthorities")).toBe(true);
  });

  test("缺失语义字段且无 fieldIssues → 服务端校验 required_field_missing（entryKey+fieldPath 可定位）", async () => {
    const html = await loadFixture("fgk-content-page.html");
    const extracted = extractLegislationPage({ html, url: FGK_URL });
    const entry = await buildLegislationEntry({ extracted, sourceKey: "fgk.chinatax.gov.cn", url: FGK_URL, recordKey: "c5233383", fetchedAt: FETCHED_AT, entryKey: "test-entry-legislation-1" });
    const raw = { contractVersion: "1", idempotencyKey: "lcaq02-test-missing", items: [{ ...entry, payload: { ...entry.payload, document: { ...entry.payload.document, fieldIssues: [] } } }] };
    const result = await validatePlatformContentBatch(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const missing = result.issues.find((issue) => issue.code === "required_field_missing");
      expect(missing?.entryKey).toBe("test-entry-legislation-1");
      expect(missing?.fieldPath).toBe("legislation.issuingAuthorities");
    }
  });

  test("列表页（无成文日期）被拒绝", async () => {
    const html = await loadFixture("fgk-listing-page.html");
    expect(() => extractLegislationPage({ html, url: "https://fgk.chinatax.gov.cn/zcfgk/c100009/listflfg_fg.html" })).toThrow(AccessRestrictedError);
  });
});

describe("裁判文书页适配器（合成 CICC 形态页面）", () => {
  test("文书字段、落款日期与引用定位（含重复引文与 speaker 分段）", async () => {
    const html = await loadFixture("cicc-judgment-page.html");
    const extracted = extractJudgmentPage({ html, url: CICC_URL });
    expect(extracted.documentType).toBe("民事判决书");
    expect(extracted.caseNumber).toBe("（2026）合成商初1号");
    expect(extracted.court).toBe("中华人民共和国最高人民法院");
    expect(extracted.decidedOn).toBe("2026-01-01");
    expect(extracted.causeOfAction).toContain("确认合同无效纠纷");
    expect(extracted.outcomeDisposition).toContain("《转让协议》无效");
    // 引文：诉辩 2 条（party）+ 查明 1 条（unknown）+ 本院认为 2 条（court）。
    expect(extracted.citations).toHaveLength(5);
    const counts: SpeakerCounts = { court: 0, party: 0, unknown: 0 };
    for (const citation of extracted.citations) {
      if (citation.speaker === "court" || citation.speaker === "party" || citation.speaker === "unknown") counts[citation.speaker] += 1;
    }
    expect(counts).toEqual({ court: 2, party: 2, unknown: 1 });
    // 重复引文：《合成合同法》第五十二条第二项出现 3 次（诉辩 party 1 次 + 本院认为 court 2 次），偏移各不相同。
    const duplicates = extracted.citations.filter((citation) => citation.rawLawName === "合成合同法");
    expect(duplicates).toHaveLength(3);
    expect(new Set(duplicates.map((citation) => citation.locator.start)).size).toBe(3);
    expect(duplicates.some((citation) => citation.speaker === "party")).toBe(true);
    expect(duplicates.some((citation) => citation.speaker === "court")).toBe(true);
    expect(extracted.citationExtractionStatus).toBe("processed_complete");
  });

  test("所有引用定位在正文以 UTF-8 字节精确还原且绑定正文摘要；批次通过服务端校验器", async () => {
    const html = await loadFixture("cicc-judgment-page.html");
    const extracted = extractJudgmentPage({ html, url: CICC_URL });
    const entry = await buildJudgmentEntry({ extracted, sourceKey: "cicc.court.gov.cn", url: CICC_URL, recordKey: "12572", fetchedAt: FETCHED_AT, entryKey: "test-entry-judgment-1" });
    const batch: IngestionBatch = { contractVersion: "1", idempotencyKey: "lcaq02-test-judgment", items: [entry] };
    const result = await validatePlatformContentBatch(batch);
    if (!result.ok) console.error(result.issues);
    expect(result.ok).toBe(true);
    const payload = batch.items[0].operation === "upsert" ? batch.items[0].payload : null;
    if (payload?.kind === "judicial_document") {
      const bodyDigest = await sha256Hex(payload.document.bodyText);
      for (const citation of payload.judgment.citations) {
        expect(citation.locator.bodyDigest).toBe(bodyDigest);
        expect(utf8Slice(payload.document.bodyText, citation.locator.start, citation.locator.end)).toBe(citation.quotedText);
      }
    }
  });

  test("栏目列表页（无文书头/落款）被拒绝", async () => {
    const html = await loadFixture("cicc-index-page.html");
    expect(() => extractJudgmentPage({ html, url: "https://cicc.court.gov.cn/html/1/218/180/316/index.html" })).toThrow(AccessRestrictedError);
  });
});

describe("来源准入与访问限制红线", () => {
  test("robots 全站禁采来源（flk/wenshu）直接拒绝", () => {
    expect(() => requireQualifiedSource("https://flk.npc.gov.cn/detail2.html")).toThrow(AccessRestrictedError);
    expect(() => requireQualifiedSource("https://wenshu.court.gov.cn/website/wenshu/index.html")).toThrow(AccessRestrictedError);
  });
  test("未准入来源拒绝", () => {
    expect(() => requireQualifiedSource("https://example.com/law")).toThrow(AccessRestrictedError);
  });
  test("robots.txt 解析与路径判定", () => {
    const disallow = parseRobotsDisallowAll("#禁止使用任何自动化工具、脚本、爬虫程序采集或复制网站数据\nUser-agent: *\nDisallow: /\n");
    expect(isPathDisallowed(disallow, "https://flk.npc.gov.cn/detail2.html")).toBe(true);
    const partial = parseRobotsDisallowAll("User-agent: *\nDisallow: /private/\n");
    expect(isPathDisallowed(partial, "https://example.com/public/page")).toBe(false);
    expect(isPathDisallowed(partial, "https://example.com/private/x")).toBe(true);
  });
});

describe("端到端：两来源合成等价批次通过校验", () => {
  test("法规 + 文书双条目批次", async () => {
    const [fgkHtml, ciccHtml] = await Promise.all([loadFixture("fgk-content-page.html"), loadFixture("cicc-judgment-page.html")]);
    const legislationExtracted = extractLegislationPage({ html: fgkHtml, url: FGK_URL });
    const judgmentExtracted = extractJudgmentPage({ html: ciccHtml, url: CICC_URL });
    const batch: IngestionBatch = {
      contractVersion: "1",
      idempotencyKey: "lcaq02-test-e2e",
      items: [
        await buildLegislationEntry({ extracted: legislationExtracted, sourceKey: "fgk.chinatax.gov.cn", url: FGK_URL, recordKey: "c5233383", fetchedAt: FETCHED_AT, entryKey: "test-entry-legislation-1" }),
        await buildJudgmentEntry({ extracted: judgmentExtracted, sourceKey: "cicc.court.gov.cn", url: CICC_URL, recordKey: "12572", fetchedAt: FETCHED_AT, entryKey: "test-entry-judgment-1" }),
      ],
    };
    const validation = await validateBatch(batch);
    expect(validation.ok).toBe(true);
  });
});
