import { test, expect } from "bun:test";
import type { CitationStatusEntry, ResourceCitationDTO } from "@surreal-ck/shared";
import { buildReportMarkdown } from "./research-export";

const entry = (overrides: Partial<CitationStatusEntry>): CitationStatusEntry => ({
  index: 1, versionPublicId: "a-v1", state: "verifiable", reason: null, fulltextOpenable: true, excerptDisplayable: true,
  ...overrides,
});

const platformCitation = (index: number, versionPublicId = "a-v1"): ResourceCitationDTO => ({
  index, title: "平台法条 A", resourceId: "content_item:a",
  evidence: [{ order: 0, text: "捕获的摘录原文" }],
  platformContent: {
    itemId: "content_item:a", versionId: "content_version:a", versionPublicId, sourceKey: "src",
    quoteSha256: "sha256:quote", entitlementRevision: "7",
    locator: { start: 2, end: 8, bodyDigest: "sha256:body" },
  },
});

test("可核验引用导出：版本、定位、哈希、捕获时间与全文指针齐备", () => {
  const markdown = buildReportMarkdown({
    workspaceSlug: "甲",
    question: "问题 Q",
    answerText: "结论 [1]",
    citations: [platformCitation(1)],
    statuses: new Map([["a-v1", entry({})]]),
    capturedAt: "2026-10-01T00:00:00Z",
    exportedAt: "2026-10-02T00:00:00Z",
  });
  expect(markdown).toContain("结论 [1]");
  expect(markdown).toContain("状态：可核验（捕获于 2026-10-01T00:00:00Z）");
  expect(markdown).toContain("精确版本：a-v1");
  expect(markdown).toContain("bodyDigest=sha256:body");
  expect(markdown).toContain("sha256:quote");
  expect(markdown).toContain("捕获时授权修订：7");
  expect(markdown).toContain("> 捕获的摘录原文");
  expect(markdown).toContain("打开时经当前授权核验");
});

test("锁定引用导出：摘录保留、全文不嵌入并注明原因", () => {
  const markdown = buildReportMarkdown({
    workspaceSlug: "甲",
    question: "Q", answerText: "回答", citations: [platformCitation(1)],
    statuses: new Map([["a-v1", entry({ state: "locked", reason: "collection_not_covered", fulltextOpenable: false })]]),
    exportedAt: "2026-10-02T00:00:00Z",
  });
  expect(markdown).toContain("全文已锁定");
  expect(markdown).toContain("当前套餐集合不包含该内容");
  expect(markdown).toContain("> 捕获的摘录原文");
  expect(markdown).not.toContain("全文指针");
});

test("墓碑与不可核验引用导出：不展示摘录，只给 tombstone 与原因", () => {
  const markdown = buildReportMarkdown({
    workspaceSlug: "甲",
    question: "Q", answerText: "回答", citations: [platformCitation(1), platformCitation(2, "b-v1")],
    statuses: new Map([
      ["a-v1", entry({ state: "tombstoned", reason: "unpublished", fulltextOpenable: false, excerptDisplayable: false })],
    ]),
    exportedAt: "2026-10-02T00:00:00Z",
  });
  expect(markdown).toContain("内容已不可用");
  expect(markdown).toContain("来源已下架或撤回");
  expect(markdown).not.toContain("> 捕获的摘录原文");
  expect(markdown).toContain("当前无法核验");
});

test("工作区资料引用按原权限导出，报告原文不重写", () => {
  const markdown = buildReportMarkdown({
    workspaceSlug: "甲",
    question: "Q",
    answerText: "原始回答文本",
    citations: [{ index: 1, title: "私有资料", resourceId: "resource_item:1", evidence: [{ order: 0, text: "私有摘录" }] }],
    statuses: new Map(),
    exportedAt: "2026-10-02T00:00:00Z",
  });
  expect(markdown).toContain("原始回答文本");
  expect(markdown).toContain("工作区资料（按工作区权限可见）");
  expect(markdown).toContain("> 私有摘录");
});
