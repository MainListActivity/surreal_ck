import type { QuotaApiCount, QuotaApiResource } from "./api";
import type { NativeQuotaResource } from "./contracts";

/**
 * 实体表建簿容量预检（CV02 返工）：
 * - 引擎原生配额按「物理字段」计数——建表事务固定追加 created_at/updated_at
 *   两个系统字段，字段需求 = 业务列数 + 系统字段数，记录需求 = 建簿事务内
 *   写入的样例/导入行数（新表初始 used=0，按 per-table 上限判定）。
 * - 规则匹配语义镜像引擎 `limit_origin`：exact 精确命中优先；否则取全部命中
 *   regex 中有限上限的最小值（regex_min）；只命中 unlimited 视为不约束；
 *   无规则命中（unmatched）不做预检阻断，交由引擎强制。
 * - 本模块只做入口友好提示的纯计算：视图缺 selector 细节（participant 视图不
 *   回 pattern/table）、用量账本不可信（used/remaining 为 null）或配额 API 不
 *   可用时返回 unknown，调用方照常发起写入，由 fork 引擎原子兜底。
 */
export const ENTITY_SYSTEM_FIELD_COUNT = 2;

export type EntitySheetDemand = Readonly<{
  /** 展示用标签（sheet 名），仅用于文案。 */
  label: string;
  /** 业务字段数（不含系统字段）。 */
  businessFields: number;
  /** 建簿事务内写入的初始记录数（样例/导入行）。 */
  initialRecords: number;
}>;

export type EntityCapacityNeed = Readonly<{
  /** 新建实体表数量（table 配额按桶计数，需与既有占用合计）。 */
  tables: number;
  /** 全部新表中物理字段需求的最大值（field 配额按表计数）。 */
  maxPhysicalFields: number;
  /** 全部新表中初始记录需求的最大值（record 配额按表计数）。 */
  maxRecordsPerTable: number;
}>;

export function computeEntityCapacityNeed(
  sheets: readonly EntitySheetDemand[],
): EntityCapacityNeed {
  return {
    tables: sheets.length,
    maxPhysicalFields: sheets.reduce(
      (max, sheet) => Math.max(max, sheet.businessFields + ENTITY_SYSTEM_FIELD_COUNT),
      0,
    ),
    maxRecordsPerTable: sheets.reduce(
      (max, sheet) => Math.max(max, sheet.initialRecords),
      0,
    ),
  };
}

export type CapacityGap = Readonly<{
  resource: NativeQuotaResource;
  /** 规则的客户可读名（customer_label）。 */
  label: string;
  /** 本次建簿所需容量。 */
  needed: number;
  /** 命中规则的有限上限。 */
  limit: number;
  /** 桶内已用量（table 配额；field/record 新表为空，恒为 0）。 */
  used: number;
  /** limit - used；field/record 等于 limit。 */
  remaining: number;
}>;

export type EntityCapacityVerdict =
  | Readonly<{ kind: "sufficient" }>
  | Readonly<{ kind: "insufficient"; gaps: readonly CapacityGap[] }>
  | Readonly<{ kind: "unknown" }>;

function toCount(value: QuotaApiCount | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

type SelectorMatch = "matched" | "unmatched" | "unknown";

function selectorMatchesTable(
  selector: QuotaApiResource["selector"],
  tableName: string,
): SelectorMatch {
  if (selector.kind === "exact") {
    return selector.table === undefined
      ? "unknown"
      : selector.table === tableName ? "matched" : "unmatched";
  }
  if (selector.pattern === undefined) return "unknown";
  try {
    return new RegExp(selector.pattern).test(tableName) ? "matched" : "unmatched";
  } catch {
    return "unknown";
  }
}

/**
 * 对一条资源取目标表名下的有效规则行。exact 命中即返回；否则汇总命中 regex
 * 的最小有限上限（regex_min）；全部命中行均 unlimited → unlimited；
 * 视图不含 selector 细节（participant）→ unknown。
 */
function effectiveLimit(
  resource: NativeQuotaResource,
  tableName: string,
  resources: readonly QuotaApiResource[],
): { kind: "finite"; resource: QuotaApiResource; limit: number }
  | { kind: "unlimited" }
  | { kind: "unknown" } {
  const candidates = resources.filter((row) => row.resource === resource);
  let unknown = false;
  let best: { resource: QuotaApiResource; limit: number } | null = null;
  let sawUnlimitedMatch = false;
  let sawAnyMatch = false;

  for (const row of candidates) {
    const match = selectorMatchesTable(row.selector, tableName);
    if (match === "unknown") {
      unknown = true;
      continue;
    }
    if (match === "unmatched") continue;
    sawAnyMatch = true;
    if (row.selector.kind === "exact") {
      // exact 命中优先级最高，短路返回。
      if (row.usage.kind === "finite") {
        const limit = toCount(row.usage.limit);
        if (limit === null) return { kind: "unknown" };
        return { kind: "finite", resource: row, limit };
      }
      return { kind: "unlimited" };
    }
    if (row.usage.kind === "finite") {
      const limit = toCount(row.usage.limit);
      if (limit === null) {
        unknown = true;
        continue;
      }
      if (!best || limit < best.limit) best = { resource: row, limit };
    } else {
      sawUnlimitedMatch = true;
    }
  }

  if (best) return { kind: "finite", resource: best.resource, limit: best.limit };
  if (sawUnlimitedMatch) return { kind: "unlimited" };
  // 全部未命中（unmatched）或细节不足：不阻断，由引擎判定。
  if (unknown || !sawAnyMatch) return { kind: "unknown" };
  return { kind: "unknown" };
}

const RESOURCE_LABELS: Record<NativeQuotaResource, string> = {
  table: "实体数据表数",
  field: "每张实体表字段数",
  record: "每张实体表记录数",
};

/**
 * 按配额视图评估新建实体表需求。`tableName` 是将要创建的实体表名（或等价的
 * 探针名），用于模拟引擎的 selector 匹配。
 */
export function evaluateEntityCapacity(
  need: EntityCapacityNeed,
  resources: readonly QuotaApiResource[],
  tableName: string,
): EntityCapacityVerdict {
  const gaps: CapacityGap[] = [];

  if (need.tables > 0) {
    const effective = effectiveLimit("table", tableName, resources);
    if (effective.kind === "unknown") return { kind: "unknown" };
    if (effective.kind === "finite") {
      const used = toCount(effective.resource.usage.kind === "finite" ? effective.resource.usage.used : null);
      const remaining = effective.resource.usage.kind === "finite"
        ? toCount(effective.resource.usage.remaining)
        : null;
      const available = remaining ?? (used === null ? null : effective.limit - used);
      if (available === null) return { kind: "unknown" };
      if (need.tables > available) {
        gaps.push({
          resource: "table",
          label: effective.resource.label || RESOURCE_LABELS.table,
          needed: need.tables,
          limit: effective.limit,
          used: used ?? 0,
          remaining: available,
        });
      }
    }
  }

  if (need.maxPhysicalFields > 0) {
    const effective = effectiveLimit("field", tableName, resources);
    if (effective.kind === "unknown") return { kind: "unknown" };
    if (effective.kind === "finite" && need.maxPhysicalFields > effective.limit) {
      gaps.push({
        resource: "field",
        label: effective.resource.label || RESOURCE_LABELS.field,
        needed: need.maxPhysicalFields,
        limit: effective.limit,
        used: 0,
        remaining: effective.limit,
      });
    }
  }

  if (need.maxRecordsPerTable > 0) {
    const effective = effectiveLimit("record", tableName, resources);
    if (effective.kind === "unknown") return { kind: "unknown" };
    if (effective.kind === "finite" && need.maxRecordsPerTable > effective.limit) {
      gaps.push({
        resource: "record",
        label: effective.resource.label || RESOURCE_LABELS.record,
        needed: need.maxRecordsPerTable,
        limit: effective.limit,
        used: 0,
        remaining: effective.limit,
      });
    }
  }

  return gaps.length > 0
    ? { kind: "insufficient", gaps }
    : { kind: "sufficient" };
}

/** 把容量缺口渲染成可读提示（需要多少 / 上限多少 / 剩余多少）。 */
export function describeCapacityGaps(gaps: readonly CapacityGap[]): string {
  const parts = gaps.map((gap) => {
    const scope = gap.resource === "table"
      ? `${gap.label}需要 ${gap.needed}，上限 ${gap.limit}，已用 ${gap.used}、剩余 ${gap.remaining}`
      : `${gap.label}需要 ${gap.needed}，上限 ${gap.limit}`;
    return scope;
  });
  return `当前套餐容量不足：${parts.join("；")}。请升级套餐或联系工作区管理员调整配额后再试。`;
}
