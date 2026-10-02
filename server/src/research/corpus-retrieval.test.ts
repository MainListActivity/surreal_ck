import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Surreal } from "surrealdb";
import { RESEARCH_EVIDENCE_LIMIT, capQuote, retrieveAuthorizedCorpus } from "./corpus-retrieval";

type Row = Record<string, unknown>;

type FakeContentRows = {
  facet?: Row[];
  gates?: Row[];
  versions?: Row[];
  articles?: Row[];
  citations?: Row[];
};

/** 按 SQL 目标表分发的假内容库会话（单元测试不触真实引擎）。 */
function fakeContentSession(rows: FakeContentRows) {
  return {
    query(sql: string, bindings?: Record<string, unknown>) {
      if (sql.includes("content_search_facet")) return Promise.resolve([rows.facet ?? []]);
      if (sql.includes("content_read_gate")) return Promise.resolve([rows.gates ?? []]);
      if (sql.includes("legal_article_version")) return Promise.resolve([rows.articles ?? []]);
      if (sql.includes("content_citation")) return Promise.resolve([rows.citations ?? []]);
      if (sql.includes("FROM content_version")) {
        const versionId = String(bindings?.version ?? "");
        const found = (rows.versions ?? []).filter((row) => String(row.id) === versionId);
        return Promise.resolve([found]);
      }
      return Promise.resolve([[]]);
    },
  } as unknown as Pick<Surreal, "query">;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const mainBody = "第一条 合同自成立时生效。第二条 当事人应当遵循诚信原则。";
const digest = sha(mainBody);

// PLATFORM_KEYWORD_QUERY 召回行形：keyword_score>0 才能进入排序，source_url 必填，
// item_id/body_sha256 作为去重身份（多候选测试需逐行区分）。
const baseFacet = {
  id: "content_search_facet:x", kind: "legislation", jurisdiction: "CN", published_on: "2026-01-01",
  source_url: "https://example.invalid/src", keyword_score: 1, item_id: "content_item:x",
};
const baseGate = {
  actions: ["browse", "search", "read", "cite"],
  ai_actions: ["research"],
  // 生效动作 = gate ∩ license；许可必须覆盖 research 才允许 AI 使用。
  license_actions: ["browse", "search", "read", "cite", "research"],
};

describe("retrieveAuthorizedCorpus", () => {
  test("法规按条登记：句柄绑定精确版本、locator、哈希与 cite 许可", async () => {
    const body = "第一条 合同自成立时生效。第二条 当事人应当遵循诚信原则。";
    const session = fakeContentSession({
      facet: [{ ...baseFacet, version_id: "content_version:v1", public_id: "a-v1", title: "甲法" }],
      gates: [{ version: "content_version:v1", ...baseGate }],
      versions: [{
        id: "content_version:v1",
        item: "content_item:a",
        public_id: "a-v1",
        title: "甲法",
        body_text: body,
        body_sha256: sha(body),
        source: "content_source:s",
        source_url: "https://example.invalid/a",
      }],
      articles: [
        { local_key: "art-1", label: "第一条", body_text: "第一条 合同自成立时生效。", locator: { start: 0, end: 12, bodyDigest: digest } },
        { local_key: "art-2", label: "第二条", body_text: "第二条 当事人应当遵循诚信原则。", locator: null },
      ],
    });

    const result = await retrieveAuthorizedCorpus({ session, query: "合同生效" });
    expect(result.candidatesSeen).toBe(1);
    expect(result.rejected).toEqual([]);
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence[0]).toMatchObject({
      versionId: "content_version:v1",
      itemId: "content_item:a",
      versionPublicId: "a-v1",
      title: "甲法",
      quote: "第一条 合同自成立时生效。",
      quoteAllowed: true,
      locator: { start: 0, end: 13, bodyDigest: digest },
      quoteSha256: sha("第一条 合同自成立时生效。"),
      bodySha256: digest,
      sourceKey: "s",
    });
  });

  test("无 AI 使用许可的候选被整体拒绝，正文不进入证据", async () => {
    const session = fakeContentSession({
      facet: [{ ...baseFacet, version_id: "content_version:v1", public_id: "a-v1", title: "甲法" }],
      gates: [{ version: "content_version:v1", ...baseGate, ai_actions: [] }],
      versions: [{ id: "content_version:v1", public_id: "a-v1", title: "甲法", body_text: "正文", body_sha256: sha("正文") }],
      articles: [{ local_key: "art-1", label: "第一条", body_text: "第一条", locator: null }],
    });
    const result = await retrieveAuthorizedCorpus({ session, query: "q" });
    expect(result.evidence).toEqual([]);
    expect(result.rejected).toEqual([{ versionPublicId: "a-v1", reason: "ai_use_denied" }]);
  });

  test("召回命中但没有本人 gate 的行 fail closed", async () => {
    const session = fakeContentSession({
      facet: [{ ...baseFacet, version_id: "content_version:v1", public_id: "a-v1", title: "甲法" }],
      gates: [],
    });
    const result = await retrieveAuthorizedCorpus({ session, query: "q" });
    expect(result.evidence).toEqual([]);
    expect(result.rejected).toEqual([{ versionPublicId: "a-v1", reason: "ai_use_denied" }]);
  });

  test("read 不获准（body_text 字段不可见）按 read_denied 拒绝", async () => {
    const session = fakeContentSession({
      facet: [{ ...baseFacet, version_id: "content_version:v1", public_id: "a-v1", title: "甲法" }],
      gates: [{ version: "content_version:v1", ...baseGate }],
      // 字段权限隐藏 body_text：行存在但字段为 NONE。
      versions: [{ id: "content_version:v1", public_id: "a-v1", title: "甲法", body_text: null, body_sha256: digest }],
      articles: [{ local_key: "art-1", label: "第一条", body_text: "第一条", locator: null }],
    });
    const result = await retrieveAuthorizedCorpus({ session, query: "q" });
    expect(result.evidence).toEqual([]);
    expect(result.rejected).toEqual([{ versionPublicId: "a-v1", reason: "read_denied" }]);
  });

  test("locator 的 bodyDigest 与版本哈希不符按 version_mismatch 拒绝该片段", async () => {
    const session = fakeContentSession({
      facet: [{ ...baseFacet, version_id: "content_version:v1", public_id: "a-v1", title: "甲法" }],
      gates: [{ version: "content_version:v1", ...baseGate }],
      versions: [{
        id: "content_version:v1",
        public_id: "a-v1",
        title: "甲法",
        body_text: "现行正文",
        body_sha256: sha("现行正文"),
      }],
      articles: [{ local_key: "art-1", label: "第一条", body_text: "旧版正文", locator: { start: 0, end: 4, bodyDigest: "b".repeat(64) } }],
    });
    const result = await retrieveAuthorizedCorpus({ session, query: "q" });
    expect(result.rejected).toEqual([{ versionPublicId: "a-v1", reason: "version_mismatch" }]);
    // 无可登记片段 → 正文受限摘录兜底，仍然绑定版本哈希。
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]!.locator).toEqual({ start: 0, end: 4, bodyDigest: sha("现行正文") });
    expect(result.evidence[0]!.bodySha256).toBe(sha("现行正文"));
  });

  test("文书引用片段需要 cite；quoted_text 不可见时回退正文摘录且不可引用", async () => {
    const body = "本院认为：合同解除条件成就。";
    const withCite = fakeContentSession({
      facet: [{ ...baseFacet, kind: "judicial_document", version_id: "content_version:c1", public_id: "c-v1", title: "乙案" }],
      gates: [{ version: "content_version:c1", ...baseGate }],
      versions: [{ id: "content_version:c1", public_id: "c-v1", title: "乙案", body_text: body, body_sha256: sha(body) }],
      citations: [{
        local_citation_key: "cite-1",
        quoted_text: "合同解除条件成就",
        locator: { start: 4, end: 12, bodyDigest: sha(body) },
      }],
    });
    const cited = await retrieveAuthorizedCorpus({ session: withCite, query: "q" });
    expect(cited.evidence).toHaveLength(1);
    expect(cited.evidence[0]).toMatchObject({ quote: "合同解除条件成就", quoteAllowed: true, locator: { start: 5, end: 13 } });

    const noCite = fakeContentSession({
      facet: [{ ...baseFacet, kind: "judicial_document", version_id: "content_version:c1", public_id: "c-v1", title: "乙案" }],
      gates: [{ version: "content_version:c1", ...baseGate, actions: ["browse", "search", "read"], license_actions: ["browse", "search", "read", "research"] }],
      versions: [{ id: "content_version:c1", public_id: "c-v1", title: "乙案", body_text: body, body_sha256: sha(body) }],
      citations: [{ local_citation_key: "cite-1", quoted_text: null, locator: null }],
    });
    const fallback = await retrieveAuthorizedCorpus({ session: noCite, query: "q" });
    expect(fallback.evidence).toHaveLength(1);
    expect(fallback.evidence[0]!.quoteAllowed).toBe(false);
    expect(fallback.evidence[0]!.quote).toBe(body);
  });

  test("片段截断到上限并按码点截断", async () => {
    const longBody = "长".repeat(1000);
    const session = fakeContentSession({
      facet: [{ ...baseFacet, version_id: "content_version:v1", public_id: "a-v1", title: "甲法" }],
      gates: [{ version: "content_version:v1", ...baseGate }],
      versions: [{ id: "content_version:v1", public_id: "a-v1", title: "甲法", body_text: longBody, body_sha256: sha(longBody) }],
      articles: [],
    });
    const result = await retrieveAuthorizedCorpus({ session, query: "q" });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]!.quote).toHaveLength(400);
    expect(result.evidence[0]!.quote).toBe(capQuote(longBody));
  });

  test("证据登记到达上限后其余候选记 evidence_overflow", async () => {
    // keyword_score 并列时按 versionId 字典序排序；零填充保持数值序，溢出仍落在 v12/v13。
    const candidates = Array.from({ length: RESEARCH_EVIDENCE_LIMIT + 2 }, (_, i) => ({
      ...baseFacet,
      version_id: `content_version:v${String(i).padStart(2, "0")}`,
      public_id: `v${i}-1`,
      title: `法${i}`,
      item_id: `content_item:i${i}`,
    }));
    const session = fakeContentSession({
      facet: candidates,
      gates: candidates.map((c) => ({ version: c.version_id, ...baseGate })),
      versions: candidates.map((c) => ({
        id: c.version_id,
        public_id: c.public_id,
        title: c.title,
        body_text: `正文${c.public_id}`,
        body_sha256: sha(`正文${c.public_id}`),
      })),
      articles: [],
    });
    const result = await retrieveAuthorizedCorpus({ session, query: "q", limit: 20 });
    expect(result.evidence).toHaveLength(RESEARCH_EVIDENCE_LIMIT);
    expect(result.rejected).toEqual([
      { versionPublicId: "v12-1", reason: "evidence_overflow" },
      { versionPublicId: "v13-1", reason: "evidence_overflow" },
    ]);
  });

  test("空查询与空召回直接返回零候选", async () => {
    expect(await retrieveAuthorizedCorpus({ session: fakeContentSession({}), query: "  " }))
      .toEqual({ evidence: [], rejected: [], candidatesSeen: 0 });
    const noHit = await retrieveAuthorizedCorpus({ session: fakeContentSession({ facet: [] }), query: "q" });
    expect(noHit).toEqual({ evidence: [], rejected: [], candidatesSeen: 0 });
  });

  // 回归（生产事故）：无 embeddingProvider 时召回曾把整句问题当单个 CONTAINS 字面量，
  // 自然语言问句必然零命中 → 研究回答零引用。必须走词项召回（$terms 绑定）。
  test("无 embedding 时按词项召回：整句问题不当子串字面量匹配", async () => {
    const body = "仓储霜层检查应当每月执行并留存记录。";
    const termBoundOnly = {
      query(sql: string, bindings?: Record<string, unknown>) {
        if (sql.includes("content_search_facet")) {
          // 只有词项召回（绑定 terms）才模拟命中；整句关键字绑定（keyword）视为零召回。
          if (!Array.isArray(bindings?.terms)) return Promise.resolve([[]]);
          expect(bindings.terms).toContain("霜层");
          return Promise.resolve([[{ ...baseFacet, item_id: "content_item:a",
            version_id: "content_version:v1", public_id: "a-v1", title: "联验合成条例A" }]]);
        }
        if (sql.includes("content_read_gate")) {
          return Promise.resolve([[{ version: "content_version:v1", ...baseGate }]]);
        }
        if (sql.includes("legal_article_version")) return Promise.resolve([[]]);
        if (sql.includes("FROM content_version")) {
          return Promise.resolve([[{ id: "content_version:v1", item: "content_item:a", public_id: "a-v1",
            title: "联验合成条例A", body_text: body, body_sha256: sha(body), source_url: "https://example.invalid/a" }]]);
        }
        return Promise.resolve([[]]);
      },
    } as unknown as Pick<Surreal, "query">;

    const result = await retrieveAuthorizedCorpus({
      session: termBoundOnly, query: "请概述《联验合成条例A》对仓储霜层检查的要求并列出可核验引用",
    });
    expect(result.candidatesSeen).toBe(1);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]!.quoteAllowed).toBe(true);
    expect(result.evidence[0]!.bodySha256).toBe(sha(body));
  });
});
