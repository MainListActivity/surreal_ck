import type { FunnelEventName } from "./events";

/**
 * 固定事件 + 固定 UTC 日的只读运营汇总（源站 funnel_event_count 聚合）。
 *
 * 计数在数据库内按 (event, day) 聚合，不逐行取回，因此不受 funnel-counts 的
 * 500 行响应上限影响，也不会返回 workspace_key。
 *
 * 抑制阈值固定：totalCount < 5 或 workspaceCount < 3 时不返回精确计数。
 * 空窗（无任何计数）与低样本分开标记，便于运营区分「没有数据」和「样本不足」。
 * 覆盖状态恒为 unknown：本汇总只证明源站聚合结果，不声明生产采集完整。
 */
export const FUNNEL_SUMMARY_MIN_TOTAL_COUNT = 5;
export const FUNNEL_SUMMARY_MIN_WORKSPACE_COUNT = 3;

export type FunnelAggregate = Readonly<{
  totalCount: number;
  workspaceCount: number;
}>;

export type FunnelSummaryState = "empty" | "suppressed" | "reported";

export type FunnelSummary = Readonly<{
  event: FunnelEventName;
  day: string;
  state: FunnelSummaryState;
  totalCount: number | null;
  workspaceCount: number | null;
  thresholds: Readonly<{
    minTotalCount: number;
    minWorkspaceCount: number;
  }>;
  coverage: Readonly<{
    state: "unknown";
    complete: false;
    reason: "no_collection_coverage_signal";
    source: "funnel_event_count";
  }>;
}>;

const COVERAGE = {
  state: "unknown",
  complete: false,
  reason: "no_collection_coverage_signal",
  source: "funnel_event_count",
} as const;

export function buildFunnelSummary(
  event: FunnelEventName,
  day: string,
  aggregate: FunnelAggregate,
): FunnelSummary {
  const thresholds = {
    minTotalCount: FUNNEL_SUMMARY_MIN_TOTAL_COUNT,
    minWorkspaceCount: FUNNEL_SUMMARY_MIN_WORKSPACE_COUNT,
  };
  if (aggregate.totalCount === 0 && aggregate.workspaceCount === 0) {
    return { event, day, state: "empty", totalCount: 0, workspaceCount: 0, thresholds, coverage: COVERAGE };
  }
  if (
    aggregate.totalCount < FUNNEL_SUMMARY_MIN_TOTAL_COUNT
    || aggregate.workspaceCount < FUNNEL_SUMMARY_MIN_WORKSPACE_COUNT
  ) {
    // 低样本只标记状态，不返回精确计数，避免被推回小样本。
    return { event, day, state: "suppressed", totalCount: null, workspaceCount: null, thresholds, coverage: COVERAGE };
  }
  return {
    event,
    day,
    state: "reported",
    totalCount: aggregate.totalCount,
    workspaceCount: aggregate.workspaceCount,
    thresholds,
    coverage: COVERAGE,
  };
}

/** 合法 UTC 日：严格的 YYYY-MM-DD 且能按 UTC 往返（排除 2026-02-30 之类）。 */
export function isUtcDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}