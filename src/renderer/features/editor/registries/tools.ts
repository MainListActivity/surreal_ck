import type { Component } from "svelte";

/**
 * 工具栏按钮注册表。
 *
 * 当前所有工具仅占位：点击仅切换 activeTool，下方 toolbar-note 显示
 * `editorUi.clipboardStatus`。未来实现某个工具时，给该项追加 `panel`
 * 字段（用于显示具体的筛选/排序/隐藏字段/分组 UI），或追加 `command`
 * 字段（直接执行动作），无需修改 EditorToolbar 容器。
 */
export type ToolRegistration = {
  id: string;
  label: string;
  icon: string;
  /** 点击后在 toolbar 下方展开的面板组件（待实现时填充） */
  panel?: Component;
  /** 点击后直接执行的命令（待实现时填充） */
  command?: () => void | Promise<void>;
};

export const toolRegistry: ToolRegistration[] = [
  { id: "filter", label: "筛选", icon: "filter" },
  { id: "sort", label: "排序", icon: "sortDesc" },
  { id: "hidden", label: "隐藏字段", icon: "eye" },
  { id: "group", label: "分组", icon: "users" },
];

export function getTool(id: string): ToolRegistration | undefined {
  return toolRegistry.find((t) => t.id === id);
}
