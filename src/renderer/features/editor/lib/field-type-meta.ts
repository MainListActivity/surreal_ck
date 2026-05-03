import { ICON_PATHS } from "../../../lib/icons";

type FieldTypeMeta = {
  icon: string;
  label: string;
};

const FIELD_TYPE_META: Record<string, FieldTypeMeta> = {
  text: { icon: "textType", label: "文本" },
  single_select: { icon: "list", label: "单选" },
  number: { icon: "hash", label: "数字" },
  decimal: { icon: "coins", label: "金额/小数" },
  date: { icon: "calendar", label: "日期" },
  checkbox: { icon: "checkSquare", label: "勾选" },
};

const FALLBACK_META: FieldTypeMeta = { icon: "docText", label: "字段" };

export function getFieldTypeMeta(fieldType: string | undefined): FieldTypeMeta {
  if (!fieldType) return FALLBACK_META;
  return FIELD_TYPE_META[fieldType] ?? FALLBACK_META;
}

export function getFieldTypeIconPaths(fieldType: string | undefined): string[] {
  const meta = getFieldTypeMeta(fieldType);
  return ICON_PATHS[meta.icon] ?? [];
}
