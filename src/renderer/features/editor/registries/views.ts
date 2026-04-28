import type { Component } from "svelte";
import type { ViewId } from "../lib/editor-ui.svelte";
import GridView from "../views/GridView.svelte";
import KanbanView from "../views/KanbanView.svelte";
import GalleryView from "../views/GalleryView.svelte";

export type ViewRegistration = {
  id: ViewId;
  label: string;
  icon: string;
  component: Component;
};

export const viewRegistry: ViewRegistration[] = [
  { id: "grid", label: "表格视图", icon: "grid", component: GridView },
  { id: "kanban", label: "看板视图", icon: "list", component: KanbanView },
  { id: "gallery", label: "画廊视图", icon: "eye", component: GalleryView },
];

export function getView(id: ViewId): ViewRegistration | undefined {
  return viewRegistry.find((v) => v.id === id);
}
