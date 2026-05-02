import type { Component } from "svelte";
import FilterPanel from "../tool-panels/FilterPanel.svelte";
import SortPanel from "../tool-panels/SortPanel.svelte";
import FieldManagerPanel from "../tool-panels/FieldManagerPanel.svelte";
import GroupPanel from "../tool-panels/GroupPanel.svelte";

/**
 * 工具栏按钮注册表。
 *
 * 每个工具可挂 `panel`（toolbar 下方展开 UI）或 `command`（直接执行动作）。
 * 筛选/排序/字段管理/分组都通过 ViewParams 或字段定义转译为 SurrealQL，由数据库执行。
 * 字段管理面板内部聚合了字段排序、显示/隐藏、编辑、删除、新增等操作。
 */
export type ToolRegistration = {
  id: string;
  label: string;
  icon: string;
  panel?: Component;
  command?: () => void | Promise<void>;
};

export const toolRegistry: ToolRegistration[] = [
  { id: "fields", label: "字段管理", icon: "spreadsheet", panel: FieldManagerPanel },
  { id: "filter", label: "筛选", icon: "filter", panel: FilterPanel },
  { id: "group", label: "分组", icon: "users", panel: GroupPanel },
  { id: "sort", label: "排序", icon: "sortDesc", panel: SortPanel },
];

export function getTool(id: string): ToolRegistration | undefined {
  return toolRegistry.find((t) => t.id === id);
}
