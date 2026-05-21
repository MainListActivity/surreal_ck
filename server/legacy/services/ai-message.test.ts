import { describe, expect, test } from "bun:test";
import { createAiUserMessage } from "../../shared/ai-context";
import type { AiContextSnapshot } from "../../shared/ai-context";

const baseContext: AiContextSnapshot = {
  route: { screen: "editor", workbookId: "workbook:case" },
  workbook: { id: "workbook:case", name: "债权工作簿" },
  sheet: { id: "sheet:claims", label: "债权申报表", tableName: "ent_claim" },
  selectedRow: {
    id: "ent_claim:abc",
    label: "张三 || ZQ-2026-001 || ent_claim:abc",
    visibleValues: { name: "张三", attachment: { fileName: "claim.pdf" } },
  },
  contextHint: "债权申报表 / 张三 || ZQ-2026-001 || ent_claim:abc",
};

describe("createAiUserMessage", () => {
  test("空白 prompt 不创建消息", () => {
    expect(createAiUserMessage({ prompt: "   ", context: baseContext })).toBeNull();
  });

  test("创建用户消息时裁剪 prompt，并固化当前上下文副本", () => {
    const message = createAiUserMessage({
      id: "msg_1",
      createdAt: "2026-05-05T14:00:00.000Z",
      prompt: "  分析当前债权  ",
      context: baseContext,
    });

    expect(message).toEqual({
      id: "msg_1",
      role: "user",
      content: "分析当前债权",
      createdAt: "2026-05-05T14:00:00.000Z",
      context: baseContext,
    });

    baseContext.selectedRow!.visibleValues.attachment = { fileName: "updated.pdf" };
    expect(message?.context.selectedRow?.visibleValues.attachment).toEqual({ fileName: "claim.pdf" });
  });
});
