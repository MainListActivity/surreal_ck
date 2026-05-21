import type { Component } from "svelte";
import type { PanelId } from "../lib/editor-ui.svelte";
import DetailPanel from "../panels/DetailPanel.svelte";
import ChangesPanel from "../panels/ChangesPanel.svelte";
import AiPanel from "../panels/AiPanel.svelte";

export type PanelRegistration = {
  id: PanelId;
  label: string;
  icon: string;
  component: Component;
};

export const panelRegistry: PanelRegistration[] = [
  { id: "detail", label: "详情", icon: "info", component: DetailPanel },
  { id: "changes", label: "最近变更", icon: "history", component: ChangesPanel },
  { id: "ai", label: "AI 助手", icon: "ai", component: AiPanel },
];

export function getPanel(id: PanelId): PanelRegistration | undefined {
  return panelRegistry.find((p) => p.id === id);
}
