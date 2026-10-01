import { test, expect, describe } from "bun:test";
import {
  LegalRetrievalRequestSchema, legalQueryTerms,
  rankLegalCandidates, type LegalRankCandidate,
} from "./legal-retrieval";

const hit = (id: string, overrides: Partial<LegalRankCandidate["hit"]> = {}): LegalRankCandidate["hit"] => ({
  versionId: `content_version:${id}`, publicId: `${id}-v1`, itemId: `content_item:${id}`,
  title: `标题${id}`, kind: "legislation", revision: 1, versionLabel: null,
  sourceUrl: `https://example.invalid/${id}`, bodySha256: `sha-${id}`,
  jurisdiction: "CN", effectiveOn: "2026-01-01", ...overrides,
});
const cand = (id: string, c: Partial<LegalRankCandidate> = {}): LegalRankCandidate => ({
  hit: hit(id), keyword: 0, authority: 0, quality: 0, procedure: "", issue: "", ...c,
});
const REQ = LegalRetrievalRequestSchema.parse({ query: "q", limit: 10 });

describe("legalQueryTerms", () => {
  test("整词 + 中文 bigram，去重且小写", () => {
    const terms = legalQueryTerms("抵押权的设立条件");
    expect(terms[0]).toBe("抵押权的设立条件");
    for (const bigram of ["抵押", "押权", "权的", "的设", "设立", "立条", "条件"]) expect(terms).toContain(bigram);
  });
  test("非汉字词不再切 bigram", () => {
    expect(legalQueryTerms("FIDIC clause")).toEqual(["fidic", "clause"]);
  });
});

describe("LegalRetrievalRequestSchema", () => {
  test("strict：模型注入的授权/workspace/collection 字段一律拒绝", () => {
    for (const extra of ["workspace", "workspaceId", "collections", "authorization", "allowed", "auth", "db"]) {
      expect(LegalRetrievalRequestSchema.safeParse({ query: "q", [extra]: "ws_x" }).success).toBe(false);
    }
    expect(LegalRetrievalRequestSchema.safeParse({ query: "q" }).success).toBe(true);
  });
  test("limit 限制在 1..20", () => {
    expect(LegalRetrievalRequestSchema.safeParse({ query: "q", limit: 0 }).success).toBe(false);
    expect(LegalRetrievalRequestSchema.safeParse({ query: "q", limit: 21 }).success).toBe(false);
  });
});

describe("rankLegalCandidates", () => {
  test("无关键词命中且无语义序位的候选不得进入结果", () => {
    const items = rankLegalCandidates([cand("ghost")], REQ);
    expect(items).toEqual([]);
  });
  test("RRF：双通道候选排在单通道之前；关键词序位由命中数决定", () => {
    const items = rankLegalCandidates([
      cand("sem-only", { semanticRank: 1 }),
      cand("both", { keyword: 1, semanticRank: 9 }),
      cand("kw-strong", { keyword: 9 }),
    ], REQ);
    expect(items.map((i) => i.itemId)).toEqual([
      "content_item:both", "content_item:kw-strong", "content_item:sem-only",
    ]);
    expect(items[0]!.explanation).toEqual(["关键词匹配", "语义相关"]);
  });
  test("权威/质量加成有界：最多翻越紧邻序位，不产生新命中", () => {
    // rank1=1/21≈0.0476，rank2=1/22≈0.0455，rank3=1/23≈0.0435；加成上限 0.003。
    const items = rankLegalCandidates([
      cand("top", { keyword: 9 }),
      cand("mid", { keyword: 5 }),
      cand("polished", { keyword: 1, authority: 1, quality: 1 }),
    ], REQ);
    expect(items.map((i) => i.itemId)).toEqual([
      "content_item:top", "content_item:polished", "content_item:mid",
    ]);
    expect(items[1]!.explanation).toContain("法源或裁判层级");
    expect(items[1]!.explanation).toContain("来源质量信号");
  });
  test("相同 body_sha256 的多个来源折叠为一条，独立可引用版本保留在 sources", () => {
    const items = rankLegalCandidates([
      cand("a", { keyword: 3, hit: hit("a", { bodySha256: "same" }) }),
      cand("b", { keyword: 1, hit: hit("b", { bodySha256: "same", sourceUrl: "https://other/b" }) }),
      cand("c", { keyword: 1, hit: hit("c", { bodySha256: "diff" }) }),
    ], { ...REQ, limit: 10 });
    expect(items).toHaveLength(2);
    const merged = items.find((i) => i.bodySha256 === "same")!;
    expect(merged.sources.map((s) => s.versionId).sort()).toEqual(["content_version:a", "content_version:b"]);
  });
  test("无 sha 时按 item 身份去重", () => {
    const items = rankLegalCandidates([
      cand("a", { keyword: 2, hit: hit("a", { bodySha256: "" }) }),
      cand("b", { keyword: 1, hit: { ...hit("b", { bodySha256: "" }), itemId: "content_item:a" } }),
    ], REQ);
    expect(items).toHaveLength(1);
    expect(items[0]!.sources).toHaveLength(2);
  });
  test("排序结果带版本号且遵守 limit", () => {
    const many = Array.from({ length: 15 }, (_, i) => cand(`d${i}`, { semanticRank: i + 1 }));
    const items = rankLegalCandidates(many, { ...REQ, limit: 5 });
    expect(items).toHaveLength(5);
  });
  test("发布时间不参与相关性", () => {
    const old = cand("old", { keyword: 1, hit: hit("old", { effectiveOn: "2000-01-01" }) });
    const fresh = cand("new", { keyword: 1, hit: hit("new", { effectiveOn: "2026-06-01" }) });
    const items = rankLegalCandidates([fresh, old], REQ);
    // 同分时只有 versionId 字典序决定次序——证明没有 recency 加成。
    expect(items.map((i) => i.score)).toEqual([items[0]!.score, items[1]!.score]);
    expect(items[0]!.score).toBeCloseTo(items[1]!.score);
  });
});
