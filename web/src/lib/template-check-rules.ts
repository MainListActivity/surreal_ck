import type {
  GridRow,
  WorkbookTemplateCheckRule,
  WorkbookTemplateCheckRules,
  WorkbookTemplateSheet,
} from "@surreal-ck/shared/dto";

export type TemplateRuleFindingCategory =
  | "duplicate_candidate"
  | "reference_missing"
  | "reference_unverifiable"
  | "consistency";

export type TemplateRuleFinding = {
  category: TemplateRuleFindingCategory;
  ruleKey: string;
  ruleVersion: string;
  sheetKey: string;
  recordId: string;
  field: string;
  explanation: string;
  evidence: unknown;
  groupKey?: string;
};

export type ScannedTemplateSheet = {
  sheetKey: string;
  records: GridRow[];
  readable: boolean;
};

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const RULE_TYPES = new Set(["duplicate", "reference_exists", "consistency"]);

export function parseTemplateCheckRules(
  value: unknown,
  sheets: readonly Pick<WorkbookTemplateSheet, "key" | "columnDefs">[],
): WorkbookTemplateCheckRules | undefined {
  if (value == null) return undefined;
  if (!isObject(value) || typeof value.version !== "string" || !Array.isArray(value.rules)) {
    throw new Error("模板检查规则必须包含版本与规则列表");
  }
  const version = value.version.trim();
  if (!version || version.length > 64) throw new Error("规则版本长度必须为 1–64 个字符");
  if (value.rules.length > 100) throw new Error("单个模板最多配置 100 条检查规则");
  const sheetFields = new Map(sheets.map((sheet) => [
    sheet.key,
    new Set(sheet.columnDefs.map((field) => field.key)),
  ]));
  const keys = new Set<string>();
  const rules = value.rules.map((raw, index) => parseRule(raw, index, sheetFields));
  for (const rule of rules) {
    if (keys.has(rule.key)) throw new Error(`规则标识重复: ${rule.key}`);
    keys.add(rule.key);
  }
  return { version, rules };
}

export function serializeTemplateCheckRules(config: WorkbookTemplateCheckRules): Record<string, unknown> {
  return {
    version: config.version,
    rules: config.rules.map((rule) => {
      if (rule.type === "duplicate") return {
        key: rule.key, type: rule.type, sheet_key: rule.sheetKey, fields: rule.fields,
        minimum_group_size: rule.minimumGroupSize, explanation: rule.explanation,
      };
      if (rule.type === "reference_exists") return {
        key: rule.key, type: rule.type, sheet_key: rule.sheetKey, field: rule.field,
        target_sheet_key: rule.targetSheetKey, explanation: rule.explanation,
      };
      return {
        key: rule.key, type: rule.type, sheet_key: rule.sheetKey,
        left_field: rule.leftField, right_field: rule.rightField, explanation: rule.explanation,
      };
    }),
  };
}

export function evaluateTemplateCheckRules(
  config: WorkbookTemplateCheckRules,
  sheets: readonly ScannedTemplateSheet[],
): TemplateRuleFinding[] {
  const byKey = new Map(sheets.map((sheet) => [sheet.sheetKey, sheet]));
  return config.rules.flatMap((rule) => {
    const source = byKey.get(rule.sheetKey);
    if (!source?.readable) return [];
    if (rule.type === "duplicate") return duplicateFindings(rule, config.version, source);
    if (rule.type === "reference_exists") {
      return referenceFindings(rule, config.version, source, byKey.get(rule.targetSheetKey));
    }
    return consistencyFindings(rule, config.version, source);
  });
}

function parseRule(
  value: unknown,
  index: number,
  sheetFields: Map<string, Set<string>>,
): WorkbookTemplateCheckRule {
  if (!isObject(value) || typeof value.type !== "string" || !RULE_TYPES.has(value.type)) {
    throw new Error(`第 ${index + 1} 条规则类型不受支持`);
  }
  const key = requiredIdentifier(value.key, "规则标识");
  const sheetKey = requiredIdentifier(value.sheet_key ?? value.sheetKey, "数据表标识");
  const fields = sheetFields.get(sheetKey);
  if (!fields) throw new Error(`规则 ${key} 引用了不存在的数据表 ${sheetKey}`);
  const explanation = requiredText(value.explanation, "规则说明", 240);
  if (value.type === "duplicate") {
    assertOnlyKeys(value, ["key", "type", "sheet_key", "sheetKey", "fields", "minimum_group_size", "minimumGroupSize", "explanation"], key);
    const rawFields = value.fields;
    if (!Array.isArray(rawFields) || rawFields.length < 1 || rawFields.length > 8) {
      throw new Error(`规则 ${key} 的重复比较字段数量必须为 1–8`);
    }
    const selected = rawFields.map((field) => requiredIdentifier(field, "比较字段"));
    selected.forEach((field) => requireField(key, field, fields));
    const minimum = Number(value.minimum_group_size ?? value.minimumGroupSize ?? 2);
    if (!Number.isInteger(minimum) || minimum < 2 || minimum > 100) {
      throw new Error(`规则 ${key} 的候选组阈值必须为 2–100 的整数`);
    }
    return { key, type: "duplicate", sheetKey, fields: selected, minimumGroupSize: minimum, explanation };
  }
  if (value.type === "reference_exists") {
    assertOnlyKeys(value, ["key", "type", "sheet_key", "sheetKey", "field", "target_sheet_key", "targetSheetKey", "explanation"], key);
    const field = requiredIdentifier(value.field, "引用字段");
    requireField(key, field, fields);
    const targetSheetKey = requiredIdentifier(value.target_sheet_key ?? value.targetSheetKey, "目标数据表标识");
    if (!sheetFields.has(targetSheetKey)) throw new Error(`规则 ${key} 引用了不存在的目标数据表 ${targetSheetKey}`);
    return { key, type: "reference_exists", sheetKey, field, targetSheetKey, explanation };
  }
  assertOnlyKeys(value, ["key", "type", "sheet_key", "sheetKey", "left_field", "leftField", "right_field", "rightField", "explanation"], key);
  const leftField = requiredIdentifier(value.left_field ?? value.leftField, "左侧字段");
  const rightField = requiredIdentifier(value.right_field ?? value.rightField, "右侧字段");
  requireField(key, leftField, fields);
  requireField(key, rightField, fields);
  if (leftField === rightField) throw new Error(`规则 ${key} 的一致性比较字段不能相同`);
  return { key, type: "consistency", sheetKey, leftField, rightField, explanation };
}

function duplicateFindings(
  rule: Extract<WorkbookTemplateCheckRule, { type: "duplicate" }>,
  version: string,
  sheet: ScannedTemplateSheet,
): TemplateRuleFinding[] {
  const groups = new Map<string, GridRow[]>();
  for (const record of sheet.records) {
    const values = rule.fields.map((field) => normalize(record.values[field]));
    if (values.every((value) => value === "")) continue;
    const key = JSON.stringify(values);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.entries()].flatMap(([groupKey, records]) => records.length < rule.minimumGroupSize ? [] :
    [...records].sort((left, right) => left.id.localeCompare(right.id)).map((record) => ({
      category: "duplicate_candidate" as const,
      ruleKey: rule.key,
      ruleVersion: version,
      sheetKey: rule.sheetKey,
      recordId: record.id,
      field: rule.fields.join(","),
      explanation: `${rule.explanation}（${records.length} 条候选，仅供核验）`,
      evidence: { normalized: JSON.parse(groupKey), candidateCount: records.length },
      groupKey,
    })));
}

function referenceFindings(
  rule: Extract<WorkbookTemplateCheckRule, { type: "reference_exists" }>,
  version: string,
  source: ScannedTemplateSheet,
  target: ScannedTemplateSheet | undefined,
): TemplateRuleFinding[] {
  const targetIds = new Set(target?.records.map((record) => record.id) ?? []);
  return source.records.flatMap((record) => {
    const reference = referenceId(record.values[rule.field]);
    if (!reference) return [];
    const readable = target?.readable === true;
    if (readable && targetIds.has(reference)) return [];
    return [{
      category: readable ? "reference_missing" as const : "reference_unverifiable" as const,
      ruleKey: rule.key,
      ruleVersion: version,
      sheetKey: rule.sheetKey,
      recordId: record.id,
      field: rule.field,
      explanation: readable ? rule.explanation : `${rule.explanation}（目标数据表不可读，无法确认是否缺失）`,
      evidence: { reference, targetSheetKey: rule.targetSheetKey, targetReadable: readable },
    }];
  });
}

function consistencyFindings(
  rule: Extract<WorkbookTemplateCheckRule, { type: "consistency" }>,
  version: string,
  source: ScannedTemplateSheet,
): TemplateRuleFinding[] {
  return source.records.flatMap((record) => {
    const left = normalize(record.values[rule.leftField]);
    const right = normalize(record.values[rule.rightField]);
    if (!left || !right || left === right) return [];
    return [{
      category: "consistency" as const,
      ruleKey: rule.key,
      ruleVersion: version,
      sheetKey: rule.sheetKey,
      recordId: record.id,
      field: `${rule.leftField},${rule.rightField}`,
      explanation: rule.explanation,
      evidence: { left, right },
    }];
  });
}

function normalize(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function referenceId(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  if (isObject(value)) {
    if (typeof value.id === "string") return value.id;
    const rendered = String(value);
    return rendered === "[object Object]" ? null : rendered;
  }
  return value == null ? null : String(value);
}

function requiredIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`${label}必须是安全标识符`);
  return value;
}

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label}长度必须为 1–${max}`);
  return value.trim();
}

function requireField(ruleKey: string, field: string, fields: Set<string>): void {
  if (!fields.has(field)) throw new Error(`规则 ${ruleKey} 引用了不存在的字段 ${field}`);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[], ruleKey: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`规则 ${ruleKey} 包含不受支持的参数 ${unexpected}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
