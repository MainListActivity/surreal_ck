import { describe, expect, test } from "bun:test";
import { DateTime } from "surrealdb";
import {
  formatDateValue,
  toDate,
  toDateInputValue,
  toDateTimeLocalValue,
} from "./date-format";

describe("日期值转换（D9 SDK DateTime 回归）", () => {
  const iso = "2026-06-02T12:30:45.123Z";

  test("SDK DateTime 转为有效 JS Date，保留毫秒", () => {
    const value = new DateTime(iso);
    expect(value instanceof Date).toBe(false);
    expect(toDate(value)?.toISOString()).toBe(iso);
  });

  test("网格与日期输入对 SDK、ISO 字符串及 JSON 传输结果显示一致", () => {
    for (const day of ["2026-06-02", "2026-06-15"]) {
      // 用本地中午避免测试进程时区影响预期日期。
      const date = new Date(`${day}T12:30:45`);
      const value = new DateTime(date);
      const serialized: unknown = JSON.parse(JSON.stringify(value));
      expect(typeof serialized).toBe("string");
      for (const input of [value, date.toISOString(), serialized]) {
        expect(formatDateValue(input, "YYYY-MM-DD")).toBe(day);
        expect(formatDateValue(input, "YYYY/MM/DD HH:mm")).toBe(`${day.replaceAll("-", "/")} 12:30`);
        expect(formatDateValue(input, null)).toBe(`${day} 12:30:45`);
        expect(toDateInputValue(input)).toBe(day);
        expect(toDateTimeLocalValue(input)).toBe(`${day}T12:30`);
      }
    }
  });

  test("原有 Date、ISO 字符串、毫秒数及零时间戳语义保留", () => {
    const date = new Date(iso);
    expect(toDate(date)).toBe(date);
    expect(toDate(iso)?.toISOString()).toBe(iso);
    expect(toDate(date.getTime())?.toISOString()).toBe(iso);
    expect(toDate(0)?.getTime()).toBe(0);
  });

  test("空值、无效值及超过 JS Date 范围的 SDK DateTime 返回 null / 空串", () => {
    for (const input of [
      undefined, null, "", "not-a-date", new Date(NaN), NaN, Infinity,
      new DateTime(8_640_000_000_001n), false, {}, [], { toDate: "invalid" },
    ]) {
      expect(toDate(input)).toBeNull();
      expect(formatDateValue(input, "YYYY-MM-DD")).toBe("");
      expect(toDateInputValue(input)).toBe("");
      expect(toDateTimeLocalValue(input)).toBe("");
    }
  });
});
