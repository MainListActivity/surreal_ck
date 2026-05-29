import type { FilterClause, FilterOp, SortClause } from "@surreal-ck/shared/rpc.types";

/**
 * 工具面板 draft 清洗（纯逻辑，可单测）。
 *
 * 面板里每行 draft 带一个本地 `id` 仅用于 `{#each}` key 与增删定位，应用前剔除；
 * 同时只保留 key 命中当前列集合的条件（防止删列后残留脏条件传给 buildSelect）。
 * 注意：这里**不**做任何权限过滤——PERMISSIONS 由数据库引擎兜底（CLAUDE.md）。
 */

export type FilterDraft = FilterClause & { id: number };
export type SortDraft = SortClause & { id: number };

/** op 决定值的形态：无值 / 标量 / 数组。 */
export function filterValueKind(op: FilterOp): "scalar" | "array" | "none" {
  if (op === "is_null" || op === "is_not_null") return "none";
  if (op === "in") return "array";
  return "scalar";
}

/**
 * 把 FilterDraft[] 清洗为可提交给 editorStore.setFilters 的 FilterClause[]：
 * - 仅保留 key ∈ knownKeys 的条件
 * - `in` 的字符串值按逗号 / 换行拆成数组
 * - 剥离本地 `id`
 */
export function cleanFilterDrafts(drafts: FilterDraft[], knownKeys: Iterable<string>): FilterClause[] {
  const allowed = new Set(knownKeys);
  return drafts
    .filter((d) => allowed.has(d.key))
    .map(({ id: _id, ...rest }) => {
      if (rest.op === "in" && typeof rest.value === "string") {
        return {
          ...rest,
          value: rest.value
            .split(/[,\n]/)
            .map((s) => s.trim())
            .filter(Boolean),
        };
      }
      return rest;
    });
}

/** 把 SortDraft[] 清洗为 SortClause[]：仅保留 key ∈ knownKeys，剥离本地 `id`（保持顺序即优先级）。 */
export function cleanSortDrafts(drafts: SortDraft[], knownKeys: Iterable<string>): SortClause[] {
  const allowed = new Set(knownKeys);
  return drafts.filter((d) => allowed.has(d.key)).map(({ id: _id, ...rest }) => rest);
}
