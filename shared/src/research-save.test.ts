import { describe, expect, test } from "bun:test";
import { validateResearchSaveRequest } from "./research-save";

const validEvidence = {
  text: "  最高法院再审认为合同无效。  ",
  sourceUrl: "https://example.com/case/1",
  sourceTitle: "裁判文书网",
  capturedAt: "2026-06-11T08:00:00.000Z",
  order: 0,
};

function validRequest() {
  return {
    sessionId: "research_session:abc",
    draft: {
      resourceType: "generic_note",
      title: "  合同无效再审案例  ",
      summary: "再审改判合同无效的关键论证。",
      evidence: [validEvidence],
      tags: ["合同", "合同", " 再审 ", ""],
    },
  };
}

describe("validateResearchSaveRequest", () => {
  test("合法 generic_note 草稿：通过校验并做 trim / tags 去重去空", () => {
    const result = validateResearchSaveRequest(validRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.sessionId).toBe("research_session:abc");
    expect(result.request.draft.title).toBe("合同无效再审案例");
    expect(result.request.draft.evidence[0].text).toBe("最高法院再审认为合同无效。");
    expect(result.request.draft.tags).toEqual(["合同", "再审"]);
    expect(result.request.draft.quality).toBe("user-confirmed");
    expect(result.request.draft.structuredPayload).toEqual({});
  });

  test("拒绝非 http/https 的 sourceUrl（草稿与证据各自报路径）", () => {
    const req = validRequest();
    (req.draft as Record<string, unknown>).sourceUrl = "javascript:alert(1)";
    req.draft.evidence = [{ ...validEvidence, sourceUrl: "file:///etc/passwd" }];

    const result = validateResearchSaveRequest(req);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.issues.map((issue) => issue.path);
    expect(paths).toContain("draft.sourceUrl");
    expect(paths).toContain("draft.evidence.0.sourceUrl");
  });

  test("证据篮为空 / 标题为空 → 校验失败", () => {
    const emptyEvidence = validRequest();
    emptyEvidence.draft.evidence = [];
    expect(validateResearchSaveRequest(emptyEvidence).ok).toBe(false);

    const blankTitle = validRequest();
    blankTitle.draft.title = "   ";
    expect(validateResearchSaveRequest(blankTitle).ok).toBe(false);
  });

  test("web_article 必须有 sourceUrl + sourceTitle；补齐后通过", () => {
    const missing = validRequest();
    missing.draft.resourceType = "web_article";
    const failed = validateResearchSaveRequest(missing);
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.issues.map((issue) => issue.path)).toContain("draft.sourceUrl");
    }

    const complete = validRequest();
    complete.draft.resourceType = "web_article";
    (complete.draft as Record<string, unknown>).sourceUrl = "https://example.com/article";
    (complete.draft as Record<string, unknown>).sourceTitle = "示例网";
    expect(validateResearchSaveRequest(complete).ok).toBe(true);
  });

  test("未知资源类型拒绝；预留类型给出已预留提示", () => {
    const unknown = validRequest();
    unknown.draft.resourceType = "podcast";
    expect(validateResearchSaveRequest(unknown).ok).toBe(false);

    const reserved = validRequest();
    reserved.draft.resourceType = "legal_case";
    const reservedResult = validateResearchSaveRequest(reserved);
    expect(reservedResult.ok).toBe(false);
    if (!reservedResult.ok) {
      expect(reservedResult.issues.some((issue) => issue.message.includes("预留"))).toBe(true);
    }
  });
});
