import { buildAiContextSnapshot } from "@surreal-ck/shared/ai-context";
import type { GridColumnDef, GridRow, RecordIdString } from "@surreal-ck/shared/rpc.types";
import type { AiDrawerContextSnapshot } from "./ai-drawer";
import type { SheetMeta, WorkbookMeta } from "./editor-store";

/** 构建抽屉快照所需的编辑器选择态切片（editorStore + editorUi 的当前值）。 */
export type DrawerEditorState = {
  workbook: WorkbookMeta | null;
  sheets: SheetMeta[];
  activeSheetId: RecordIdString | null;
  rows: GridRow[];
  visibleColumns: GridColumnDef[];
  selectedRowId: RecordIdString | null;
};

export type DrawerContextInput = {
  workspaceSlug: string | null | undefined;
  routeScreen: string;
  /** 仅 editor 路由下消费；其他路由传入也会被忽略，防止陈旧编辑器状态泄入快照。 */
  editor?: DrawerEditorState | null;
};

/**
 * 把「当前路由 + 编辑器选择态」映射成发往 `/api/chat` 的上下文快照。
 * 每次发消息时调用，永远基于当下状态构建——不缓存，因此不会发送陈旧快照。
 */
export function buildDrawerContextSnapshot(input: DrawerContextInput): AiDrawerContextSnapshot {
  const editor = input.routeScreen === "editor" ? input.editor ?? null : null;
  const sheetMeta = editor ? editor.sheets.find((s) => s.id === editor.activeSheetId) ?? null : null;

  const snapshot = buildAiContextSnapshot({
    route: {
      screen: input.routeScreen,
      workbookId: editor?.workbook?.id,
      sheetId: sheetMeta?.id,
    },
    workbook: editor?.workbook ?? null,
    sheet: sheetMeta ? { id: sheetMeta.id, label: sheetMeta.label, tableName: sheetMeta.tableName } : null,
    selectedRowId: editor?.selectedRowId ?? null,
    rows: editor?.rows,
    visibleColumns: editor?.visibleColumns,
  });

  return { ...snapshot, workspaceSlug: input.workspaceSlug ?? undefined };
}
