import type { SurrealConn } from "./surreal";

export type ActivityTab = "activity" | "overview" | "tasks";

export type ChartBar = {
  label: string;
  value: number;
};

export function formatRelativeTime(ts: Date, now: Date = new Date()): string {
  const diffMs = Math.max(0, now.getTime() - ts.getTime());
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin}分钟前`;

  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startDate = new Date(ts.getFullYear(), ts.getMonth(), ts.getDate()).getTime();
  const dayDiff = Math.round((startToday - startDate) / 86400000);

  if (dayDiff === 1) return "昨天";

  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}小时前`;
  if (dayDiff < 7) return `${dayDiff}天前`;

  return ts.toLocaleDateString("zh-CN");
}

export async function countWorkbooks(conn: Pick<SurrealConn, "query">): Promise<number> {
  const rows = await conn.query<{ count: number }>(
    "SELECT count() FROM workbook GROUP ALL",
  );
  return rows[0]?.count ?? 0;
}

/** 一天对应的本地日期 key（YYYY-MM-DD），与 SurrealDB time::format 同口径但按本地时区。 */
function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
function weekdayLabel(date: Date): string {
  return WEEKDAY_LABELS[date.getDay()];
}

/** SurrealDB 按天聚合返回的一行。 */
export type DailyCountRow = { day: string; value: number };

/**
 * 纯逻辑：把按天聚合结果补成连续 `days` 天的桶（最旧→最新，含今天），缺失日期补 0，
 * label 用中文星期。`day` 为 YYYY-MM-DD（按本地时区比对，与 localDayKey 一致）。
 */
export function buildTrendBuckets(rows: DailyCountRow[], days: number, now: Date = new Date()): ChartBar[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.day, (counts.get(r.day) ?? 0) + (r.value ?? 0));

  const bars: ChartBar[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = localDayKey(date);
    bars.push({ label: weekdayLabel(date), value: counts.get(key) ?? 0 });
  }
  return bars;
}

/**
 * 读最近 `days` 天每天的动态事件数，补零后返回 `ChartBar[]`（供数据概览迷你 bar chart）。
 * 单表 + created_at 索引，比跨所有实体表聚合轻。PERMISSIONS 兜底，查询不带鉴权过滤。
 */
export async function loadDailyActivityTrend(
  conn: Pick<SurrealConn, "query">,
  days = 7,
  now: Date = new Date(),
): Promise<ChartBar[]> {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const rows = await conn.query<DailyCountRow>(
    'SELECT time::format(created_at, "%Y-%m-%d") AS day, count() AS value FROM activity_event WHERE created_at >= $since GROUP BY day ORDER BY day',
    { since: start },
  );
  return buildTrendBuckets(rows, days, now);
}
