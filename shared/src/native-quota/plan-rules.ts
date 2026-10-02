import type { ProductQuotaRule } from "./control-plane";

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

/**
 * CV02 返工：Max 第二修订。字段/记录口径按引擎物理口径统一——field 计入
 * created_at/updated_at 系统字段（实体表 9 业务列 + 2 系统字段 = 11），
 * record 覆盖模板样例行数（claims 12）。v1（3/9/6）保持不可变留存，供既有
 * 订阅与审计对照；新供给由 seed 把 quota_plan:max.active_revision 指向 v2，
 * 既有 workspace 经正常运营事件（subscription_upsert 指向 max_v2）升级。
 */
export const MAX_V2_REVISION_KEY = "max_v2";

export const MAX_V2_LIMITS = { tables: 3, fields: 11, records: 12 } as const;
