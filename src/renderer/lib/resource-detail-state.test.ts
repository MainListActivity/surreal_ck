import { describe, expect, test } from "bun:test";
import { canRetryResourceEmbedding, formatStructuredPayload, resourceDetailSourceLabel } from "./resource-detail-state";
import type { ResourceDTO } from "../../shared/rpc.types";

const baseResource = {
  sourceTitle: "Example",
  sourceUrl: "https://example.com/article",
} satisfies Pick<ResourceDTO, "sourceTitle" | "sourceUrl">;

describe("resource detail view state", () => {
  test("只有 failed 和 stale embedding 状态允许资源级重试", () => {
    expect(canRetryResourceEmbedding("failed")).toBe(true);
    expect(canRetryResourceEmbedding("stale")).toBe(true);
    expect(canRetryResourceEmbedding("pending")).toBe(false);
    expect(canRetryResourceEmbedding("indexed")).toBe(false);
    expect(canRetryResourceEmbedding("disabled")).toBe(false);
  });

  test("详情来源标签优先显示 sourceTitle，其次 sourceUrl", () => {
    expect(resourceDetailSourceLabel(baseResource)).toBe("Example");
    expect(resourceDetailSourceLabel({ sourceUrl: "https://example.com/article" })).toBe("https://example.com/article");
    expect(resourceDetailSourceLabel({})).toBe("未记录来源");
  });

  test("structuredPayload 以稳定 JSON 展示", () => {
    expect(formatStructuredPayload({ siteName: "Example" })).toBe('{\n  "siteName": "Example"\n}');
  });
});
