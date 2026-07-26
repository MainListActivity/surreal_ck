import type { ProductQuotaRule } from "@surreal-ck/shared/native-quota";

/**
 * Complete product rules for one commercial tier. Includes managed ^ent_
 * coverage, .* unlimited fallbacks, and exact system exceptions required by
 * the policy compiler.
 */
export function commercialProductRules(limits: {
  tables: number;
  fields: number;
  records: number;
}): ProductQuotaRule[] {
  return [
    {
      rule_key: "fallback-table",
      resource: "table",
      selector: { kind: "regex", value: ".*" },
      limit: { kind: "unlimited" },
      customer_label: "其他数据表",
    },
    {
      rule_key: "entity-tables",
      resource: "table",
      selector: { kind: "regex", value: "^ent_" },
      limit: { kind: "finite", value: limits.tables },
      customer_label: "实体数据表数",
    },
    {
      rule_key: "fallback-field",
      resource: "field",
      selector: { kind: "regex", value: ".*" },
      limit: { kind: "unlimited" },
      customer_label: "其他表字段",
    },
    {
      rule_key: "entity-fields",
      resource: "field",
      selector: { kind: "regex", value: "^ent_" },
      limit: { kind: "finite", value: limits.fields },
      customer_label: "每张实体表字段数",
    },
    {
      rule_key: "system-sheet-fields",
      resource: "field",
      selector: { kind: "exact", value: "sheet" },
      limit: { kind: "unlimited" },
      customer_label: "系统数据表字段",
    },
    {
      rule_key: "fallback-record",
      resource: "record",
      selector: { kind: "regex", value: ".*" },
      limit: { kind: "unlimited" },
      customer_label: "其他表记录",
    },
    {
      rule_key: "entity-records",
      resource: "record",
      selector: { kind: "regex", value: "^ent_" },
      limit: { kind: "finite", value: limits.records },
      customer_label: "每张实体表记录数",
    },
    {
      rule_key: "system-sheet-records",
      resource: "record",
      selector: { kind: "exact", value: "sheet" },
      limit: { kind: "unlimited" },
      customer_label: "系统数据表记录",
    },
  ];
}

/** Aligns with historical 020 Plus / Pro / Max tier numbers. */
export const SEEDED_PLAN_LIMITS = {
  trial: { tables: 1, fields: 3, records: 2 },
  plus: { tables: 1, fields: 3, records: 2 },
  pro: { tables: 2, fields: 6, records: 4 },
  max: { tables: 3, fields: 9, records: 6 },
  retention: { tables: 0, fields: 0, records: 0 },
} as const;

export type SeededPlanKey = keyof typeof SEEDED_PLAN_LIMITS;
