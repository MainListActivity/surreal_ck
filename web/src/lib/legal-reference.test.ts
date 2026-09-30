import { test, expect } from "bun:test";
import { legalReferenceData } from "./legal-reference";
import type { ContentPage } from "./content-reader";

const page: ContentPage = {
  versionId: "content_version:v1", publicId: "law-v1", title: "测试法规", revision: 1,
  versionLabel: null, sourceUrl: "https://example.invalid/law", sourceForm: "full_text",
  publishedAt: "2026-01-01T00:00:00Z", bodyText: "不得写入的正文", canCite: true,
  articles: [], authorizedUntilSeconds: 1_000_000,
};

test("workspace citation contains only exact pointer, source, locator and own note", () => {
  const record = legalReferenceData({ page, locator: "article:1", note: "我的观点" });
  expect(record.content_version_id).toBe("content_version:v1");
  expect(record.locator).toBe("article:1");
  expect(JSON.stringify(record)).not.toContain("不得写入的正文");
  expect(() => legalReferenceData({ page: { ...page, canCite: false }, locator: null, note: "" })).toThrow();
  expect(() => legalReferenceData({ page, locator: null, note: "x".repeat(4001) })).toThrow();
});
