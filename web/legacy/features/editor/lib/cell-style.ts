export type StatusTone = "success" | "info" | "warning" | "error";

export function statusTone(value: unknown): StatusTone {
  const text = String(value ?? "");
  if (/(通过|完成|已完成|active|open)/i.test(text)) return "success";
  if (/(审核中|处理中|pending)/i.test(text)) return "info";
  if (/(退回|拒绝|失败|closed|error)/i.test(text)) return "error";
  return "warning";
}

export function cardAccent(value: unknown): string {
  return `var(--${statusTone(value)})`;
}

export function cardPillStyle(value: unknown): string {
  const tone = statusTone(value);
  return `--pill-bg:var(--${tone}-bg);--pill-color:var(--${tone})`;
}
