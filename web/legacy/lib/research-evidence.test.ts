import { describe, expect, test } from "bun:test";
import {
  addEvidenceSnippet,
  createEvidenceFromPaste,
  removeEvidenceSnippet,
} from "./research-evidence";

describe("research evidence basket", () => {
  test("add/delete 后保持证据顺序连续", () => {
    const first = addEvidenceSnippet([], {
      text: "第一段证据",
      capturedAt: "2026-05-11T08:00:00.000Z",
      sourceUrl: "https://example.com/a",
      sourceTitle: "Example",
    });
    const second = addEvidenceSnippet(first, {
      text: "第二段证据",
      capturedAt: "2026-05-11T08:01:00.000Z",
      sourceUrl: "https://example.com/a",
      sourceTitle: "Example",
    });

    expect(second.map((item) => item.order)).toEqual([0, 1]);
    expect(removeEvidenceSnippet(second, 0)).toEqual([
      {
        text: "第二段证据",
        capturedAt: "2026-05-11T08:01:00.000Z",
        sourceUrl: "https://example.com/a",
        sourceTitle: "Example",
        order: 0,
      },
    ]);
  });

  test("paste fallback 会 trim 文本并保留来源信息", () => {
    const evidence = createEvidenceFromPaste({
      text: "  手动粘贴证据  ",
      sourceUrl: "https://example.com/a",
      sourceTitle: "Example",
      capturedAt: "2026-05-11T08:00:00.000Z",
      order: 2,
    });

    expect(evidence).toEqual({
      text: "手动粘贴证据",
      sourceUrl: "https://example.com/a",
      sourceTitle: "Example",
      capturedAt: "2026-05-11T08:00:00.000Z",
      order: 2,
    });
  });
});
