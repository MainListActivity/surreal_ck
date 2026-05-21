import { describe, expect, test } from "bun:test";
import {
  listResourceTypeDefinitions,
  prepareSharedResourceDraft,
} from "./shared-resource-library";

describe("shared resource library", () => {
  test("发布草稿会校验资源类型、规范化标签，并生成稳定 duplicate hashes", () => {
    const draft = prepareSharedResourceDraft({
      workspaceId: "workspace:demo",
      resourceType: "web_article",
      title: "  网页资料  ",
      summary: "  网页摘要  ",
      sourceUrl: " https://example.com/a ",
      sourceTitle: " Example ",
      evidence: [
        {
          text: "网页正文证据。",
          sourceUrl: "https://example.com/a",
          sourceTitle: "Example",
          capturedAt: "2026-05-11T07:59:00.000Z",
          order: 0,
        },
      ],
      tags: [" 合同 ", "合同", "案例"],
      structuredPayload: {
        author: "Researcher",
      },
      quality: "user-confirmed",
    });
    const sameDraft = prepareSharedResourceDraft({
      ...draft.normalized,
      tags: ["合同", "案例"],
      structuredPayload: { author: "Researcher" },
    });

    expect(draft.normalized).toMatchObject({
      title: "网页资料",
      summary: "网页摘要",
      sourceUrl: "https://example.com/a",
      sourceTitle: "Example",
      tags: ["合同", "案例"],
      structuredPayload: { author: "Researcher" },
    });
    expect(draft.duplicateHashes).toEqual(sameDraft.duplicateHashes);
    expect(draft.duplicateHashes.content).toHaveLength(64);
    expect(listResourceTypeDefinitions()).toContainEqual({ type: "legal_case", status: "reserved" });
  });
});
