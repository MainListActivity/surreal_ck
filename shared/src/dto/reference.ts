import type { RecordIdString } from "./transport";

// ─── Reference DTOs ──────────────────────────────────────────────────────────

/** 一条被引用记录在 UI 中的展示快照（单元格徽章 / 悬停浮窗 / 详情侧栏共用）。 */
export type ReferenceTargetPreview = {
  id: RecordIdString;
  /** "app_user" 或 "ent_xxx"。 */
  table: string;
  /** 仅当 table 是 ent_* 时存在。 */
  workspaceId?: RecordIdString;
  workspaceName?: string;
  workbookId?: RecordIdString;
  workbookName?: string;
  sheetId?: RecordIdString;
  sheetName?: string;
  /** 单元格主显示文本，例如 "name 字段值" 或 "Sheet 名 / 主键 id"。 */
  primaryLabel: string;
  /** 当被引用记录已被删除时为 true，UI 渲染为「已删除的记录」。 */
  missing?: boolean;
  /** 浮窗用前 4–6 个字段值；不展示 id / workspace / created_* / updated_* 等系统字段。 */
  preview: Array<{ key: string; label: string; value: unknown }>;
};

export type ReferenceTargetOption = {
  /** 目标表名。 */
  table: string;
  /** UI 用的显示名，例如 "工作簿名 / Sheet 名" 或 "系统：用户"。 */
  label: string;
  /** 仅当 table 是 ent_* 时存在；用于 UI 树状分组与缓存。 */
  workspaceId?: RecordIdString;
  workspaceName?: string;
  workbookId?: RecordIdString;
  workbookName?: string;
  sheetId?: RecordIdString;
  sheetName?: string;
  /** 列出可用作展示字段的列：[{key,label,fieldType}] */
  displayKeys: Array<{ key: string; label: string; fieldType: string }>;
};
