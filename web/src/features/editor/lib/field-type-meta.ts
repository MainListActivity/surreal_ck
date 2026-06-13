import type { Component } from "svelte";
import { Type, List, Hash, Coins, Calendar, SquareCheck, Link, FileText } from "@lucide/svelte";
import { GRID_ICON_PATHS } from "../../../lib/grid-icon-paths";

type FieldTypeMeta = {
  icon: Component;
  gridIconKey: string;
  label: string;
};

const FIELD_TYPE_META: Record<string, FieldTypeMeta> = {
  text: { icon: Type, gridIconKey: "type", label: "文本" },
  single_select: { icon: List, gridIconKey: "list", label: "单选" },
  number: { icon: Hash, gridIconKey: "hash", label: "数字" },
  decimal: { icon: Coins, gridIconKey: "coins", label: "金额/小数" },
  date: { icon: Calendar, gridIconKey: "calendar", label: "日期" },
  checkbox: { icon: SquareCheck, gridIconKey: "squareCheck", label: "勾选" },
  reference: { icon: Link, gridIconKey: "link", label: "引用" },
};

const FALLBACK_META: FieldTypeMeta = { icon: FileText, gridIconKey: "fileText", label: "字段" };

export function getFieldTypeMeta(fieldType: string | undefined): FieldTypeMeta {
  if (!fieldType) return FALLBACK_META;
  return FIELD_TYPE_META[fieldType] ?? FALLBACK_META;
}

export function getFieldTypeIconPaths(fieldType: string | undefined): string[] {
  const meta = getFieldTypeMeta(fieldType);
  return GRID_ICON_PATHS[meta.gridIconKey] ?? [];
}
