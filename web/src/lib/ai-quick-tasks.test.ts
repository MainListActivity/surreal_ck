import { describe, expect, test } from "bun:test";
import type { AiDrawerContextSnapshot, AiDrawerSession } from "./ai-drawer";
import { presentAiQuickTasks, submitAiQuickTask } from "./ai-quick-tasks";
import { recordToTemplate } from "./workbook-templates";

function snapshot(workbookId: string, sheetId: string, selectedRowId?: string): AiDrawerContextSnapshot {
  return {
    workspaceSlug: "acme",
    route: { screen: "editor", workbookId, sheetId },
    workbook: { id: workbookId, name: workbookId },
    sheet: { id: sheetId, label: sheetId, tableName: "ent_items" },
    selectedRow: selectedRowId
      ? { id: selectedRowId, label: selectedRowId, visibleValues: { name: "当前记录" } }
      : null,
    contextHint: sheetId,
  };
}

const template = recordToTemplate({
  id: "workbook_template:operations",
  key: "operations",
  label: "运营台账",
  quick_tasks: [
    { key: "summary", label: "汇总", task_text: "汇总当前数据", sheet_keys: ["items"], risk: "query" },
    { key: "update", label: "更新", task_text: "更新当前记录", sheet_keys: ["items"], risk: "write" },
    { key: "add-field", label: "增加字段", task_text: "增加优先级字段", sheet_keys: ["items"], risk: "ddl" },
  ],
});

describe("AI 模板快捷任务", () => {
  test("点击时读取最新上下文，并只生成一次正常 AI 请求", async () => {
    const calls: Array<{ message: string; context: AiDrawerContextSnapshot }> = [];
    const session = {
      async sendMessage(message: string, context: AiDrawerContextSnapshot) {
        calls.push({ message, context });
      },
    } as Pick<AiDrawerSession, "sendMessage">;
    let current = snapshot("workbook:old", "sheet:old");
    const [action] = presentAiQuickTasks(template, "items", "admin");
    current = snapshot("workbook:new", "sheet:new", "ent_items:selected");

    await submitAiQuickTask(action!, session, () => current);

    expect(calls).toEqual([{ message: "汇总当前数据", context: current }]);
  });

  test("普通成员看到 DDL 管理员权限提示，点击不生成 AI 请求", async () => {
    let calls = 0;
    const session = {
      async sendMessage() { calls += 1; },
    } as Pick<AiDrawerSession, "sendMessage">;
    const action = presentAiQuickTasks(template, "items", "participant")
      .find((item) => item.task.risk === "ddl")!;

    const submitted = await submitAiQuickTask(action, session, () => snapshot("workbook:one", "sheet:one"));

    expect(action).toMatchObject({ disabled: true, permissionMessage: "需要管理员权限" });
    expect(submitted).toBe(false);
    expect(calls).toBe(0);
  });
});
