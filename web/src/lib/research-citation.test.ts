import { test, expect } from "bun:test";
import type { ResourceCitationDTO } from "@surreal-ck/shared";
import { researchCitationHref, researchCitationExcerpt } from "./research-citation";

test("平台引用回链固定公开版本和位置，旧快照不回退外站", () => {
  const citation: ResourceCitationDTO = { index: 2, title: "fixture", resourceId: "content_item:a",
    sourceUrl: "https://example.invalid/latest", platformContent: { itemId: "content_item:a",
      versionId: "content_version:a", versionPublicId: "a-v1", sourceKey: "s",
      locator: { start: 2, end: 4, bodyDigest: "abc" } } };
  expect(researchCitationHref("甲", citation)).toBe("/w/%E7%94%B2/content/a-v1#research=start=2&end=4&digest=abc");
  expect(researchCitationHref(null, citation)).toBeNull();
  delete citation.platformContent!.versionPublicId;
  expect(researchCitationHref("甲", citation)).toBeNull();
});

test("定位只展示摘要匹配的精确正文片段，越界与变更正文拒绝", async () => {
  const body = "前言第一条。";
  const digest = new Bun.CryptoHasher("sha256").update(body).digest("hex");
  const hash = `#research=start=2&end=5&digest=${digest}`;
  expect(await researchCitationExcerpt(body, hash)).toBe("第一条");
  expect(await researchCitationExcerpt("修改后", hash)).toBeNull();
  expect(await researchCitationExcerpt(body, `#research=start=-1&end=5&digest=${digest}`)).toBeNull();
});
