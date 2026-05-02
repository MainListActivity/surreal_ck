import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";

dayjs.extend(customParseFormat);

export const DEFAULT_DATE_FORMAT = "YYYY-MM-DD HH:mm:ss";

export type DateFormatPreset = {
  value: string;
  label: string;
  /** 该格式是否包含时分秒；用于决定单元格 editor / 表单 input 类型。 */
  hasTime: boolean;
};

export const DATE_FORMAT_PRESETS: DateFormatPreset[] = [
  { value: "YYYY-MM-DD HH:mm:ss", label: "2024-01-31 14:30:00", hasTime: true },
  { value: "YYYY-MM-DD HH:mm", label: "2024-01-31 14:30", hasTime: true },
  { value: "YYYY-MM-DD", label: "2024-01-31", hasTime: false },
  { value: "YYYY/MM/DD HH:mm", label: "2024/01/31 14:30", hasTime: true },
  { value: "YYYY/MM/DD", label: "2024/01/31", hasTime: false },
  { value: "MM/DD/YYYY", label: "01/31/2024", hasTime: false },
  { value: "DD/MM/YYYY", label: "31/01/2024", hasTime: false },
  { value: "YYYY年MM月DD日", label: "2024年01月31日", hasTime: false },
  { value: "YYYY年MM月DD日 HH:mm", label: "2024年01月31日 14:30", hasTime: true },
];

const TIME_TOKENS = /[HhmsSAa]/;

/** 判断格式串里是否含有时间部分。 */
export function dateFormatHasTime(format: string | undefined | null): boolean {
  if (!format) return true; // 默认格式带时间
  return TIME_TOKENS.test(format);
}

export function resolveDateFormat(format: string | undefined | null): string {
  const trimmed = (format ?? "").trim();
  return trimmed || DEFAULT_DATE_FORMAT;
}

/** 把任意日期值转成 Date；解析失败返回 null。 */
export function toDate(value: unknown): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string") {
    const d = dayjs(value);
    if (d.isValid()) return d.toDate();
    return null;
  }
  return null;
}

/** 把日期值按格式渲染；空/无效返回 ""。 */
export function formatDateValue(value: unknown, format: string | undefined | null): string {
  const date = toDate(value);
  if (!date) return "";
  return dayjs(date).format(resolveDateFormat(format));
}

/**
 * 将 `<input type="datetime-local">` / `<input type="date">` 的值
 * 转回 Date（本地时区）。空字符串返回 null。
 */
export function parseDateInput(raw: string, hasTime: boolean): Date | null {
  if (!raw) return null;
  // datetime-local: "2024-01-31T14:30" 或 "2024-01-31T14:30:00"
  // date:           "2024-01-31"
  const fmt = hasTime
    ? raw.length > 16
      ? "YYYY-MM-DDTHH:mm:ss"
      : "YYYY-MM-DDTHH:mm"
    : "YYYY-MM-DD";
  const d = dayjs(raw, fmt, true);
  if (!d.isValid()) return null;
  return d.toDate();
}

/**
 * 把日期值转成 `<input type="datetime-local">` 期待的字符串
 * （本地时区，"YYYY-MM-DDTHH:mm"）。空值返回 ""。
 */
export function toDateTimeLocalValue(value: unknown): string {
  const d = toDate(value);
  if (!d) return "";
  return dayjs(d).format("YYYY-MM-DDTHH:mm");
}

/** 把日期值转成 `<input type="date">` 期待的字符串（本地时区，"YYYY-MM-DD"）。空值返回 ""。 */
export function toDateInputValue(value: unknown): string {
  const d = toDate(value);
  if (!d) return "";
  return dayjs(d).format("YYYY-MM-DD");
}

/**
 * 校验自定义格式串是否合法。dayjs 不会因为格式串错误抛错，
 * 只能通过 format 后再 parse 回来比对。
 */
export function isValidDateFormat(format: string): boolean {
  const sample = dayjs("2024-01-31T14:30:45.000Z");
  try {
    const text = sample.format(format);
    return text.length > 0 && text !== format;
  } catch {
    return false;
  }
}
