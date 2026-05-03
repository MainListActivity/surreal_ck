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

describe("reference 字段", () => {
  const singleColumn: GridColumnDef = {
    key: "owner",
    label: "负责人",
    fieldType: "reference",
    referenceTable: "app_user",
    referenceMultiple: false,
  };

  const multiColumn: GridColumnDef = {
    key: "linked_cases",
    label: "关联案件",
    fieldType: "reference",
    referenceTable: "ent_abc12345_def67890_ghi23456",
    referenceMultiple: true,
  };

  test("单选 reference 校验目标表归属", () => {
    expect(validateGridFieldValue("ent_abc:zzz", singleColumn)).toContain("引用值必须属于 app_user");
    expect(validateGridFieldValue("not_a_record_id", singleColumn)).toContain("引用值不是合法 RecordId");
    expect(validateGridFieldValue("app_user:abc12345", singleColumn)).toHaveLength(0);
  });

  test("多选 reference 校验数组里每个元素", () => {
    expect(
      validateGridFieldValue([
        "ent_abc12345_def67890_ghi23456:row1",
        "app_user:wrongtable",
      ], multiColumn),
    ).toContain("引用值必须属于 ent_abc12345_def67890_ghi23456");
    expect(
      validateGridFieldValue([
        "ent_abc12345_def67890_ghi23456:row1",
        "ent_abc12345_def67890_ghi23456:row2",
      ], multiColumn),
    ).toHaveLength(0);
  });

  test("多选 coerce 把空数组规整为 null，去重保留原顺序", () => {
    expect(coerceGridFieldValue([], multiColumn)).toBeNull();
    expect(coerceGridFieldValue(["a:1", "a:1", "a:2"], multiColumn)).toEqual(["a:1", "a:2"]);
  });

  test("单选 coerce 把数组退化为首个非空字符串", () => {
    expect(coerceGridFieldValue(["app_user:abc"], singleColumn)).toBe("app_user:abc");
  });

  test("required 时空数组算空", () => {
    const required: GridColumnDef = { ...multiColumn, required: true };
    expect(validateGridFieldValue([], required)).toContain("必填");
  });
});
