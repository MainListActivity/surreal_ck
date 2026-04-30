import { describe, expect, test } from "bun:test";
import {
  coerceGridFieldValue,
  normalizeGridFieldConstraints,
  validateGridFieldValue,
} from "../../shared/field-schema";
import type { GridColumnDef } from "../../shared/rpc.types";

describe("normalizeGridFieldConstraints", () => {
  test("文本长度上下界颠倒时抛错", () => {
    expect(() => normalizeGridFieldConstraints("text", { minLength: 10, maxLength: 2 }))
      .toThrow("最小长度不能大于最大长度");
  });

  test("日期约束会标准化为 ISO 字符串", () => {
    const constraints = normalizeGridFieldConstraints("date", { minDate: "2026-04-01" });
    expect(constraints?.minDate).toBe("2026-04-01T00:00:00.000Z");
  });
});

describe("validateGridFieldValue", () => {
  test("数字字段校验整数和步长", () => {
    const column: GridColumnDef = {
      key: "qty",
      label: "数量",
      fieldType: "number",
      constraints: { min: 0, step: 2 },
    };

    expect(validateGridFieldValue(3, column)).toContain("必须按 2 的步长变化");
    expect(validateGridFieldValue(4.5, column)).toContain("必须是整数");
    expect(validateGridFieldValue(6, column)).toHaveLength(0);
  });

  test("单选字段校验候选值", () => {
    const column: GridColumnDef = {
      key: "status",
      label: "状态",
      fieldType: "single_select",
      options: ["open", "closed"],
    };

    expect(validateGridFieldValue("draft", column)).toContain("必须选择预定义选项");
    expect(validateGridFieldValue("open", column)).toHaveLength(0);
  });
});

describe("coerceGridFieldValue", () => {
  test("勾选和日期字段按类型转换", () => {
    const checkbox = coerceGridFieldValue("true", {
      key: "enabled",
      label: "启用",
      fieldType: "checkbox",
    });
    const date = coerceGridFieldValue("2026-04-30", {
      key: "opened_at",
      label: "开始日期",
      fieldType: "date",
    });

    expect(checkbox).toBe(true);
    expect(date).toBeInstanceOf(Date);
  });
});
