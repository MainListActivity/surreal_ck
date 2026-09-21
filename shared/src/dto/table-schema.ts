// ─── Table schema introspection ──────────────────────────────────────────────

/** 给仪表盘 builder 使用的字段元数据。统一用于业务表(ent_*)和系统表。 */
export type TableSchemaField = {
  /** 字段名。 */
  key: string;
  /** UI 展示名。业务表来自 column_defs.label；系统表用人工映射。 */
  label: string;
  /** 归一化字段类型：text/number/currency/date/boolean/reference/select/json/unknown。 */
  fieldType: string;
  /** 是否可空（来自 surreal 的 option<...> 推断或 column_defs.required）。 */
  nullable?: boolean;
  /** 仅当字段是 reference 时存在；目标表名。 */
  referenceTable?: string;
};
