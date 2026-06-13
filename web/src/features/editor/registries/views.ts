import type { Component } from "svelte";
import type { ViewId } from "../lib/editor-ui";
import GridView from "../views/GridView.svelte";
import KanbanView from "../views/KanbanView.svelte";
import GalleryView from "../views/GalleryView.svelte";
import FormView from "../views/FormView.svelte";
import { Grid3x3, List, Eye, Pencil } from "@lucide/svelte";

export type ViewRegistration = {
  id: ViewId;
  label: string;
  icon: Component;
  component: Component;
};

export const viewRegistry: ViewRegistration[] = [
  { id: "grid", label: "表格视图", icon: Grid3x3, component: GridView },
  { id: "kanban", label: "看板视图", icon: List, component: KanbanView },
  { id: "gallery", label: "画廊视图", icon: Eye, component: GalleryView },
  { id: "form", label: "表单视图", icon: Pencil, component: FormView },
];

export function getView(id: ViewId): ViewRegistration | undefined {
  return viewRegistry.find((v) => v.id === id);
}
