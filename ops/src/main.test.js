import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");

describe("运营启用摘要页面", () => {
  test("复用授权摘要 API，支持详情、分页与明确数据来源", () => {
    expect(source).toContain('data-view="activation"');
    expect(source).toContain("/ops/activation-summaries?limit=25");
    expect(source).toContain("/ops/activation-summaries/${encodeURIComponent(summaryId)}");
    expect(source).toContain("团队提供");
    expect(source).toContain("未知、未完成和失败保持独立显示");
  });
});
