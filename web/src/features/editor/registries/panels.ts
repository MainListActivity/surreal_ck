import type { Component } from "svelte";
import type { PanelId } from "../lib/editor-ui";
import DetailPanel from "../panels/DetailPanel.svelte";
import ChangesPanel from "../panels/ChangesPanel.svelte";
import { Info, History } from "@lucide/svelte";

export type PanelRegistration = {
  id: PanelId;
  label: string;
  icon: Component;
  component: Component;
};

export const panelRegistry: PanelRegistration[] = [
  { id: "detail", label: "详情", icon: Info, component: DetailPanel },
  { id: "changes", label: "最近变更", icon: History, component: ChangesPanel },
];

export function getPanel(id: PanelId): PanelRegistration | undefined {
  return panelRegistry.find((p) => p.id === id);
}
