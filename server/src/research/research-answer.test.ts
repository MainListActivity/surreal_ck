import { describe, expect, test } from "bun:test";
import {
  assembleResearchAnswerText,
  buildResearchPrompt,
  createEvidenceRegistry,
  citationDTO,
  parseCitationHandles,
  validateResearchAnswer,
  type CorpusAvailability,
} from "./research-answer";

function registryWithCite() {
  const registry = createEvidenceRegistry(12);
  const platformHandle = registry.register({
    sourceType: "platform",
    title: "甲法",
    quote: "第一条 合同自成立时生效。",
    platform: {
      versionId: "content_version:v1",
      itemId: "content_item:i1",
      versionPublicId: "a-v1",
      sourceKey: "s",
      sourceUrl: "https://example.invalid/a",
      locator: { start: 0, end: 12, bodyDigest: "d".repeat(64) },
      quoteSha256: "q1",
      bodySha256: "d".repeat(64),
      kind: "legislation",
      versionLabel: "2026 修订",
    },
  })!;
  const privateHandle = registry.register({
    sourceType: "private",
    title: "案件笔记",
    quote: "法院认为解除通知到达后合同解除。",
    private: {
      resourceId: "resource_item:r1",
      resourceType: "generic_note",
      sourceUrl: "https://example.com/note",
      order: 0,
    },
  })!;
  return { registry, platformHandle, privateHandle };
}

describe("research evidence registry", () => {
  test("登记返回递增句柄并按来源去重", () => {
    const registry = createEvidenceRegistry(12);
    const first = registry.register({ sourceType: "private", title: "t", quote: "同一段文字" });
    const duplicate = registry.register({ sourceType: "private", title: "t", quote: "同一段文字" });
    const other = registry.register({ sourceType: "platform", title: "t", quote: "同一段文字" });
    expect(first).toBe(1);
    expect(duplicate).toBeNull();
    expect(other).toBe(2);
  });

  test("超过上限不再登记", () => {
    const registry = createEvidenceRegistry(2);
    registry.register({ sourceType: "private", title: "t", quote: "a" });
    registry.register({ sourceType: "private", title: "t", quote: "b" });
    expect(registry.register({ sourceType: "private", title: "t", quote: "c" })).toBeNull();
  });

  test("空片段不登记", () => {
    const registry = createEvidenceRegistry(12);
    expect(registry.register({ sourceType: "private", title: "t", quote: "   " })).toBeNull();
  });
});

describe("buildResearchPrompt", () => {
  test("提示词只包含登记证据，未登记的唯一标记绝不出现", () => {
    const { registry } = registryWithCite();
    const prompt = buildResearchPrompt({
      question: "合同什么时候生效？",
      registry,
      corpusAvailability: "ready",
    });
    expect(prompt).toContain("[1] 甲法（版本 2026 修订）：第一条 合同自成立时生效。");
    expect(prompt).toContain("[2] 案件笔记：法院认为解除通知到达后合同解除。");
    expect(prompt).toContain("合同什么时候生效？");
    // 授权外内容从未登记：它的标记不能进入提示词。
    expect(prompt).not.toContain("UNAUTHORIZED-CANARY");
  });

  test("quoteAllowed=false 的片段标注仅参考", () => {
    const registry = createEvidenceRegistry(12);
    registry.register({
      sourceType: "platform",
      title: "乙法",
      quote: "第二条 仅供参考。",
      quoteAllowed: false,
      platform: null,
    });
    const prompt = buildResearchPrompt({ question: "q", registry, corpusAvailability: "ready" });
    expect(prompt).toContain("仅参考、不可引用");
    expect(prompt).toContain("[1] 乙法：第二条 仅供参考。");
  });

  test("平台不可用时提示词带 unavailable 状态", () => {
    const { registry } = registryWithCite();
    const prompt = buildResearchPrompt({ question: "q", registry, corpusAvailability: "unavailable" });
    expect(prompt).toContain("平台语料当前不可用（unavailable）");
  });
});

describe("validateResearchAnswer", () => {
  test("真实句柄不能包装虚构引文，大编号也作为伪造拒绝", () => {
    const { registry } = registryWithCite();
    const result = validateResearchAnswer({ modelText: "甲法规定“无限责任” [1]，另据 [9999]。", registry });
    expect(result.rejected).toEqual([{ handle: 1, reason: "unsupported_quote" }, { handle: 9999, reason: "forged" }]);
    expect(result.citations).toEqual([]);
  });
  test("引用次序不同仍使用登记句柄，不能重排为另一来源", () => {
    const { registry } = registryWithCite();
    const result = validateResearchAnswer({ modelText: "材料 [2] 后参照 [1]", registry });
    expect(result.citations.map((citation) => citation.index)).toEqual([2, 1]);
    expect(result.citations[0]?.evidence?.[0]?.order).toBe(0);
  });
  test("伪造句柄被剔除并记因，合法句柄生成登记表来源的引用快照", () => {
    const { registry, platformHandle } = registryWithCite();
    const result = validateResearchAnswer({
      modelText: "结论成立 [1]；参见 [3] 与 [99]。",
      registry,
    });
    expect(result.citedHandles).toEqual([platformHandle]);
    expect(result.rejected).toEqual([
      { handle: 3, reason: "forged" },
      { handle: 99, reason: "forged" },
    ]);
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toMatchObject({
      index: 1,
      resourceId: "content_item:i1",
      title: "甲法",
      platformContent: {
        itemId: "content_item:i1",
        versionId: "content_version:v1",
        sourceKey: "s",
        locator: { start: 0, end: 12, bodyDigest: "d".repeat(64) },
      },
    });
    // 引用快照的事实字段来自登记表，而不是模型输出。
    expect(result.citations[0]!.evidence![0]!.text).toBe("第一条 合同自成立时生效。");
  });

  test("引用 quoteAllowed=false 的句柄按缺少引用许可剔除", () => {
    const registry = createEvidenceRegistry(12);
    registry.register({
      sourceType: "platform",
      title: "乙法",
      quote: "仅供参考片段",
      quoteAllowed: false,
      platform: {
        versionId: "content_version:v2",
        itemId: "content_item:i2",
        versionPublicId: "b-v1",
        sourceKey: "s",
        sourceUrl: null,
        locator: null,
        quoteSha256: "q",
        bodySha256: null,
        kind: "legislation",
        versionLabel: null,
      },
    });
    const result = validateResearchAnswer({ modelText: "分析 [1]", registry });
    expect(result.citedHandles).toEqual([]);
    expect(result.rejected).toEqual([{ handle: 1, reason: "cite_not_allowed" }]);
    expect(result.citations).toEqual([]);
  });

  test("私有材料句柄可引用且不带 platformContent", () => {
    const { registry, privateHandle } = registryWithCite();
    const result = validateResearchAnswer({ modelText: `依据 [${privateHandle}]`, registry });
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]!.resourceId).toBe("resource_item:r1");
    expect(result.citations[0]!.platformContent).toBeUndefined();
  });
});

describe("assembleResearchAnswerText", () => {
  test("区分来源事实、用户材料与模型分析", () => {
    const { registry } = registryWithCite();
    const text = assembleResearchAnswerText({
      question: "q",
      registry,
      corpusAvailability: "ready",
      analysisText: "合同自成立时生效 [1]，并参照私有笔记 [2]。",
      rejected: [],
      citedHandles: [1, 2],
    });
    const sections = text.split("\n\n");
    expect(sections[0]!.startsWith("【来源事实】")).toBe(true);
    expect(text).toContain("【用户材料】（工作区私有资料）");
    expect(text).toContain("【模型分析】\n合同自成立时生效 [1]");
    expect(text).not.toContain("【覆盖说明】");
  });

  test("平台不可用 / 无证据 / 被拒引用进入覆盖说明", () => {
    const empty = createEvidenceRegistry(12);
    const unavailable = assembleResearchAnswerText({
      question: "q",
      registry: empty,
      corpusAvailability: "unavailable" satisfies CorpusAvailability,
      analysisText: "",
      rejected: [{ handle: 5, reason: "forged" }, { handle: 6, reason: "cite_not_allowed" }],
      citedHandles: [],
      candidateRejections: 2,
    });
    expect(unavailable).toContain("【覆盖说明】");
    expect(unavailable).toContain("仅基于工作区私有资料（partial）");
    expect(unavailable).toContain("未登记到任何可用证据；本回答不构成有来源的法律结论");
    expect(unavailable).toContain("引用 [5] 未通过核验（句柄未登记），已从引用中移除。");
    expect(unavailable).toContain("引用 [6] 缺少引用许可，已从引用中移除。");
    expect(unavailable).toContain("有 2 条平台候选因授权不足未纳入（未进入模型上下文）。");
  });

  test("empty（无授权集合）单独说明", () => {
    const text = assembleResearchAnswerText({
      question: "q",
      registry: createEvidenceRegistry(12),
      corpusAvailability: "empty",
      analysisText: "",
      rejected: [],
      citedHandles: [],
    });
    expect(text).toContain("平台语料当前没有可授权集合");
  });
});

describe("parseCitationHandles", () => {
  test("按首次出现去重且忽略非法编号", () => {
    expect(parseCitationHandles("a [2] b [1] c [2] d [0] e [9999] f [x]")).toEqual([2, 1, 9999]);
  });
});

describe("citationDTO", () => {
  test("未登记句柄直接抛错（后处理不生成事实）", () => {
    const registry = createEvidenceRegistry(12);
    expect(() => citationDTO(registry, 1, 1)).toThrow();
  });
});
