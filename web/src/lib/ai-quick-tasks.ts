import type { WorkbookTemplate, WorkbookTemplateQuickTask } from "@surreal-ck/shared/rpc.types";
import type { WorkspaceRole } from "./permissions";
import type { AiDrawerContextSnapshot, AiDrawerSession } from "./ai-drawer";
import { quickTasksForSheet } from "./workbook-templates";

export type AiQuickTaskPresentation = {
  task: WorkbookTemplateQuickTask;
  disabled: boolean;
  permissionMessage?: string;
};

/** 把模板任务裁成当前数据表/当前身份可展示的通用 UI 模型。 */
export function presentAiQuickTasks(
  template: WorkbookTemplate | undefined,
  templateSheetKey: string | null | undefined,
  role: WorkspaceRole | null | undefined,
): AiQuickTaskPresentation[] {
  return quickTasksForSheet(template, templateSheetKey).map((task) => {
    const denied = task.risk === "ddl" && role !== "admin";
    return {
      task,
      disabled: denied,
      ...(denied ? { permissionMessage: "需要管理员权限" } : {}),
    };
  });
}

/** 点击任务时现取上下文；禁用项不创建 Router workflow run。 */
export async function submitAiQuickTask(
  action: AiQuickTaskPresentation,
  session: Pick<AiDrawerSession, "sendMessage">,
  getContextSnapshot: () => AiDrawerContextSnapshot,
): Promise<boolean> {
  if (action.disabled) return false;
  await session.sendMessage(action.task.taskText, getContextSnapshot());
  return true;
}
