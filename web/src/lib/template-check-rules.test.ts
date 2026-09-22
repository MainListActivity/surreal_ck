import { describe, expect, test } from "bun:test";
import type { GridRow, WorkbookTemplateSheet } from "@surreal-ck/shared/dto";
import { evaluateTemplateCheckRules, parseTemplateCheckRules } from "./template-check-rules";

const sheets = [
  { key: "claims", label: "债权", columnDefs: [
    { key: "name", label: "名称", field_type: "text" },
    { key: "alias", label: "别名", field_type: "text" },
    { key: "creditor", label: "债权人", field_type: "reference" },
  ] },
  { key: "creditors", label: "债权人", columnDefs: [
    { key: "name", label: "名称", field_type: "text" },
  ] },
] as WorkbookTemplateSheet[];

const row = (id: string, values: Record<string, unknown>): GridRow => ({ id, values });

describe("模板检查规则", () => {
  test("只接受受限规则类型，并校验模板字段与阈值", () => {
    expect(() => parseTemplateCheckRules({ version: "v1", rules: [{
      key: "x", type: "script", sheet_key: "claims", query: "DELETE claim", explanation: "x",
    }] }, sheets)).toThrow("类型不受支持");
    expect(() => parseTemplateCheckRules({ version: "v1", rules: [{
      key: "x", type: "duplicate", sheet_key: "claims", fields: ["name"],
      explanation: "x", query: "SELECT * FROM claim",
    }] }, sheets)).toThrow("不受支持的参数 query");
    expect(() => parseTemplateCheckRules({ version: "v1", rules: [{
      key: "dup", type: "duplicate", sheet_key: "claims", fields: ["missing"],
      minimum_group_size: 1, explanation: "候选",
    }] }, sheets)).toThrow("不存在的字段");
  });

  test("重复候选跨分页仍组成稳定分组，输入顺序不影响证据", () => {
    const config = parseTemplateCheckRules({ version: "v1", rules: [{
      key: "same_name", type: "duplicate", sheet_key: "claims", fields: ["name"],
      minimum_group_size: 2, explanation: "名称规范化后相同",
    }] }, sheets)!;
    const records = Array.from({ length: 501 }, (_, index) => row(`claim:r${index + 1}`, {
      name: index === 0 ? " ACME " : index === 500 ? "acme" : `债权 ${index}`,
    }));
    const first = evaluateTemplateCheckRules(config, [{ sheetKey: "claims", records, readable: true }]);
    const reversed = evaluateTemplateCheckRules(config, [{ sheetKey: "claims", records: [...records].reverse(), readable: true }]);

    expect(first.map((finding) => finding.recordId)).toEqual(["claim:r1", "claim:r501"]);
    expect(first.map((finding) => finding.groupKey)).toEqual(reversed.map((finding) => finding.groupKey));
    expect(first.every((finding) => finding.category === "duplicate_candidate")).toBe(true);
    expect(first[0]?.explanation).toContain("仅供核验");
  });

  test("区分引用确认缺失与目标表不可读，并执行字段一致性比较", () => {
    const config = parseTemplateCheckRules({ version: "v7", rules: [
      { key: "creditor_exists", type: "reference_exists", sheet_key: "claims", field: "creditor", target_sheet_key: "creditors", explanation: "债权人引用不存在" },
      { key: "names_match", type: "consistency", sheet_key: "claims", left_field: "name", right_field: "alias", explanation: "名称与别名不一致" },
    ] }, sheets)!;
    const source = { sheetKey: "claims", readable: true, records: [
      row("claim:a", { name: "甲", alias: "乙", creditor: "creditor:missing" }),
    ] };
    const missing = evaluateTemplateCheckRules(config, [source, { sheetKey: "creditors", readable: true, records: [] }]);
    const unreadable = evaluateTemplateCheckRules(config, [source, { sheetKey: "creditors", readable: false, records: [] }]);

    expect(missing.map((finding) => finding.category)).toEqual(["reference_missing", "consistency"]);
    expect(unreadable.map((finding) => finding.category)).toEqual(["reference_unverifiable", "consistency"]);
    expect(missing.every((finding) => finding.ruleVersion === "v7")).toBe(true);
  });
});
