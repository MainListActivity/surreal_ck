import type { SurrealConn } from "./surreal";

export type ActivityTab = "activity" | "overview" | "tasks";

export type ActivityEntry = {
  id: string;
  actor: string;
  action: string;
  timestamp: Date;
};

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

const NOW = new Date();
const h = (hours: number) => new Date(NOW.getTime() - hours * 3600000);
const d = (days: number) => new Date(NOW.getTime() - days * 86400000);

export const MOCK_ACTIVITY_ENTRIES: ActivityEntry[] = [
  { id: "1", actor: "张三", action: "添加了 12 条记录", timestamp: h(2) },
  { id: "2", actor: "AI 助手", action: "生成了 SurrealQL 查询", timestamp: d(1) },
  { id: "3", actor: "李四", action: "新建了工作簿「债权台账 v2」", timestamp: d(1) },
  { id: "4", actor: "王五", action: "修改了 3 个字段定义", timestamp: d(2) },
  { id: "5", actor: "张三", action: "导入了 Excel 文件", timestamp: d(3) },
  { id: "6", actor: "AI 助手", action: "完成了资源检索任务", timestamp: d(5) },
  { id: "7", actor: "李四", action: "邀请了新成员加入工作区", timestamp: d(7) },
];

export const MOCK_CHART_BARS: ChartBar[] = [
  { label: "周一", value: 8 },
  { label: "周二", value: 23 },
  { label: "周三", value: 15 },
  { label: "周四", value: 41 },
  { label: "周五", value: 19 },
  { label: "周六", value: 6 },
  { label: "周日", value: 12 },
];
