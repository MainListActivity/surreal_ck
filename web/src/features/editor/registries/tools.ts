import type { Component } from "svelte";
import FieldManagerPanel from "../tool-panels/FieldManagerPanel.svelte";
import FilterPanel from "../tool-panels/FilterPanel.svelte";
import SortPanel from "../tool-panels/SortPanel.svelte";
import GroupPanel from "../tool-panels/GroupPanel.svelte";
import { Filter, Users, ArrowDownUp, Sheet } from "@lucide/svelte";

/**
 * 工具栏按钮注册表。
 *
 * 每个工具可挂 `panel`（toolbar 下方展开 UI）或 `command`（直接执行动作）。
 * 筛选 / 排序 / 分组都通过 ViewParams 转译为 SurrealQL（参数化 + 列白名单），由数据库执行。
 * 字段管理走 editorStore 的 DDL 编排（DEFINE/REMOVE FIELD + column_defs 持久化）。
 */
export type ToolRegistration = {
  id: string;
  label: string;
  icon: Component;
  panelWidth?: number;
  panel?: Component;
  command?: () => void | Promise<void>;
};

export const toolRegistry: ToolRegistration[] = [
  { id: "filter", label: "筛选", icon: Filter, panel: FilterPanel, panelWidth: 640 },
  { id: "group", label: "分组", icon: Users, panel: GroupPanel, panelWidth: 420 },
  { id: "sort", label: "排序", icon: ArrowDownUp, panel: SortPanel, panelWidth: 520 },
  { id: "fields", label: "字段管理", icon: Sheet, panel: FieldManagerPanel, panelWidth: 360 },
];

export function getTool(id: string): ToolRegistration | undefined {
  return toolRegistry.find((t) => t.id === id);
}
