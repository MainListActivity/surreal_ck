import { describe, expect, test } from "bun:test";
import { StringRecordId } from "surrealdb";
import {
  applyCitationResolutionOverlays,
  baseArticleLabel,
  normalizeLawTitle,
  planCitationResolutions,
} from "./citation-resolution";

const version = (id: string, title: string, effectiveOn: string | null, versionResolution = "resolved") => ({
  recordId: new StringRecordId(`content_version:${id}`),
  itemId: `item-${id}`,
  versionId: `version-${id}`,
  title,
  versionResolution,
  effectiveOn,
});

const article = (versionId: string, label: string) => ({
  recordId: new StringRecordId(`legal_article_version:${versionId}-${label}`),
  versionRecordId: new StringRecordId(`content_version:${versionId}`),
  label,
});

const citation = (decidedOn: string | null) => ({
  recordId: new StringRecordId("content_citation:c1"),
  localCitationKey: "citation-1",
  relationKind: "explicit_citation" as const,
  rawLawName: "《中华人民共和国著作权法》",
  rawArticleLabel: "第十条第一款",
  decidedOn,
});

describe("citation resolution", () => {
  test("规范化书名号并从款项引用中提取基础条号", () => {
    expect(normalizeLawTitle(" 《中华人民共和国著作权法》 ")).toBe("中华人民共和国著作权法");
    expect(baseArticleLabel("第十条第一款第一项")).toBe("第十条");
  });

  test("按裁判日期从多个已解析版本中唯一选择生效版本并标记 verified", () => {
    const plans = planCitationResolutions({
      citations: [citation("2022-06-01")],
      legislation: [
        version("copyright-2010", "中华人民共和国著作权法", "2010-04-01"),
        version("copyright-2020", "中华人民共和国著作权法", "2021-06-01"),
      ],
      articles: [article("copyright-2010", "第十条"), article("copyright-2020", "第十条")],
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]?.status).toBe("verified");
    expect(plans[0]?.candidates.map((item) => item.versionId)).toEqual(["version-copyright-2020"]);
  });

  test("版本元数据未解析时只提出候选，不冒充已核验", () => {
    const plans = planCitationResolutions({
      citations: [citation("2022-06-01")],
      legislation: [version("copyright", "中华人民共和国著作权法", "2021-06-01", "unresolved")],
      articles: [article("copyright", "第十条")],
    });
    expect(plans[0]?.status).toBe("proposed");
  });

  test("检索结果使用最新解析修订覆盖入库快照中的 unresolved", () => {
    const item = {
      itemId: "case-1",
      kind: "judicial_document" as const,
      title: "案例一",
      version: {
        versionId: "version-case-1",
        versionLabel: null,
        sourceKey: "court.gov.cn",
        sourceUrl: "https://court.gov.cn/case-1",
        publishedAt: null,
        updatedAt: null,
        bodyBytes: 10,
        publicationStatus: "published" as const,
      },
      judgment: {
        citations: [{
          localCitationKey: "citation-1",
          relationKind: "explicit_citation" as const,
          speaker: "court" as const,
          quotedText: "依照著作权法第十条",
          locator: { start: 0, end: 9, bodyDigest: "a".repeat(64) },
          rawLawName: "中华人民共和国著作权法",
          rawArticleLabel: "第十条",
          resolution: "unresolved" as const,
          candidates: [],
        }],
      },
      bodyText: "裁判正文",
    };
    const [resolved] = applyCitationResolutionOverlays([item], [{
      versionId: "version-case-1",
      localCitationKey: "citation-1",
      status: "verified",
      candidates: [{ itemId: "law-1", versionId: "law-v1", articleId: null }],
    }]);
    expect(resolved?.judgment?.citations?.[0]?.resolution).toBe("verified");
    expect(resolved?.judgment?.citations?.[0]?.candidates?.[0]?.versionId).toBe("law-v1");
  });
});
