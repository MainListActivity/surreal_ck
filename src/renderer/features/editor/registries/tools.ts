import type { Component } from "svelte";
import FilterPanel from "../tool-panels/FilterPanel.svelte";
import SortPanel from "../tool-panels/SortPanel.svelte";
import HiddenFieldsPanel from "../tool-panels/HiddenFieldsPanel.svelte";
import GroupPanel from "../tool-panels/GroupPanel.svelte";

/**
 * 工具栏按钮注册表。
 *
 * 每个工具可挂 `panel`（toolbar 下方展开 UI）或 `command`（直接执行动作）。
 * 筛选/排序/隐藏/分组都通过 ViewParams 转译成 SurrealQL 查询，由数据库执行。
 */
export type ToolRegistration = {
  id: string;
  label: string;
  icon: string;
  panel?: Component;
  command?: () => void | Promise<void>;
};

export const toolRegistry: ToolRegistration[] = [
  { id: "filter", label: "筛选", icon: "filter", panel: FilterPanel },
  { id: "sort", label: "排序", icon: "sortDesc", panel: SortPanel },
  { id: "hidden", label: "隐藏字段", icon: "eye", panel: HiddenFieldsPanel },
  { id: "group", label: "分组", icon: "users", panel: GroupPanel },
];

export function getTool(id: string): ToolRegistration | undefined {
  return toolRegistry.find((t) => t.id === id);
}
