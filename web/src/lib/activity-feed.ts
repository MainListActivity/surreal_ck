import type { SurrealConn } from "./surreal";
import { recordValueToString } from "./record-id";
import { formatRelativeTime } from "./activity-panel";

/**
 * 首页「动态」读取层（纯逻辑；runes 镜像在 activity-feed.svelte.ts）。
 *
 * 写入完全由 SurrealDB 引擎层 DEFINE EVENT 负责（010 静态表 event + 建表事务里的
 * record_activity event），前端只读：初次 SELECT + LIVE 订阅增量。本文件负责
 * 行 → 中文文案的映射、actor 显示名解析、以及「同人短时窗口同表的 record.write
 * 聚合成『添加了 N 条记录』」的渲染层聚合，避免逐行刷屏。
 */

/** activity_event 表读回的原始行（SDK 把 record 字段读成 RecordId 实例，这里在边界转回 string）。 */
export type ActivityEventRow = {
  id: string;
  actor?: string;
  verb: string;
  target_kind?: string;
  target_name?: string;
  target?: string;
  created_at: string;
};

/** 聚合后供组件渲染的一条动态。 */
export type ActivityFeedItem = {
  id: string;
  /** actor 的 user record id（string 形态）；用于解析显示名 / 头像。 */
  actorId?: string;
  verb: string;
  /** 已拼好的中文动作描述，如「新建了工作簿「债权台账」」「添加了 12 条记录」。 */
  action: string;
  timestamp: Date;
  /** 该条聚合自多少个原始事件（record.write 聚合用；>1 时文案显示数量）。 */
  count: number;
};

/** 读最近的动态行。PERMISSIONS 已兜底，查询不带鉴权过滤；只携带分页选项。 */
export async function loadActivityRows(
  conn: Pick<SurrealConn, "query">,
  limit = 50,
): Promise<ActivityEventRow[]> {
  const rows = await conn.query<Record<string, unknown>>(
    "SELECT id, actor, verb, target_kind, target_name, target, created_at FROM activity_event ORDER BY created_at DESC LIMIT $limit",
    { limit },
  );
  return rows.map(normalizeRow);
}

/** 把 SDK 读回的行规整成 string 形态（RecordId → "table:id"）。 */
export function normalizeRow(rec: Record<string, unknown>): ActivityEventRow {
  return {
    id: String(recordValueToString(rec.id)),
    actor: rec.actor != null ? String(recordValueToString(rec.actor)) : undefined,
    verb: typeof rec.verb === "string" ? rec.verb : "",
    target_kind: typeof rec.target_kind === "string" ? rec.target_kind : undefined,
    target_name: typeof rec.target_name === "string" ? rec.target_name : undefined,
    target: rec.target != null ? String(recordValueToString(rec.target)) : undefined,
    created_at: typeof rec.created_at === "string" ? rec.created_at : String(rec.created_at ?? ""),
  };
}

/** verb → 动作模板。`{name}` 占位由 target_name 填充，`{n}` 由聚合 count 填充。 */
const VERB_TEMPLATES: Record<string, { withName: string; bare: string }> = {
  "workbook.create": { withName: "新建了工作簿「{name}」", bare: "新建了一个工作簿" },
  "workbook.rename": { withName: "重命名了工作簿「{name}」", bare: "重命名了一个工作簿" },
  "workbook.delete": { withName: "删除了工作簿「{name}」", bare: "删除了一个工作簿" },
  "sheet.create": { withName: "新建了数据表「{name}」", bare: "新建了一张数据表" },
  "sheet.delete": { withName: "删除了数据表「{name}」", bare: "删除了一张数据表" },
  "dashboard.create": { withName: "新建了仪表盘「{name}」", bare: "新建了一个仪表盘" },
  "dashboard.delete": { withName: "删除了仪表盘「{name}」", bare: "删除了一个仪表盘" },
  "field.define": { withName: "调整了字段「{name}」", bare: "调整了字段定义" },
  "field.remove": { withName: "删除了字段「{name}」", bare: "删除了一个字段" },
  "record.write": { withName: "添加了 {n} 条记录", bare: "添加了 {n} 条记录" },
  "record.delete": { withName: "删除了 {n} 条记录", bare: "删除了 {n} 条记录" },
  "ai.write": { withName: "AI 写入了数据", bare: "AI 写入了数据" },
  "resource.save": { withName: "保存了资源「{name}」", bare: "保存了一份资源" },
};

/** 把一条聚合后的动态拼成中文动作文案。 */
export function describeActivity(verb: string, targetName: string | undefined, count: number): string {
  const tmpl = VERB_TEMPLATES[verb];
  if (!tmpl) return "进行了一次操作";
  const base = targetName ? tmpl.withName : tmpl.bare;
  return base.replace("{name}", targetName ?? "").replace("{n}", String(count));
}

/** 聚合窗口：同 actor + 同表 + record.write/delete 在此窗口内合并成一条。 */
export const RECORD_AGGREGATION_WINDOW_MS = 5 * 60 * 1000;

/** 从 target（record id "table:id"）取表名，供 record.* 聚合分组。 */
function tableOf(target: string | undefined): string {
  if (!target) return "";
  const colon = target.indexOf(":");
  return colon > 0 ? target.slice(0, colon) : target;
}

/** 聚合过程的工作项：比 ActivityFeedItem 多带分组比较用的中间字段，输出前剥掉。 */
type WorkingItem = ActivityFeedItem & { targetName?: string; targetTable: string };

/**
 * 把按时间倒序的原始行聚合成可渲染列表：
 * - record.write / record.delete：同 actor + 同表，相邻且时间差 < 窗口的合并成一条（count 累加）。
 * - 其余 verb：一行一条，不聚合。
 * 输入须已按 created_at DESC 排序（loadActivityRows / LIVE 插表头都保证）。纯函数，无外部状态。
 */
export function aggregateActivity(rows: ActivityEventRow[]): ActivityFeedItem[] {
  const working: WorkingItem[] = [];
  for (const row of rows) {
    const ts = new Date(row.created_at);
    const isRecord = row.verb === "record.write" || row.verb === "record.delete";
    const table = tableOf(row.target);
    const prev = working[working.length - 1];
    if (
      isRecord &&
      prev &&
      prev.verb === row.verb &&
      prev.actorId === row.actor &&
      prev.targetTable === table &&
      Math.abs(prev.timestamp.getTime() - ts.getTime()) < RECORD_AGGREGATION_WINDOW_MS
    ) {
      prev.count += 1;
      prev.action = describeActivity(prev.verb, prev.targetName, prev.count);
      // 用最早（即更旧）的时间戳作为这组的代表，相对时间更稳定。
      if (ts.getTime() < prev.timestamp.getTime()) prev.timestamp = ts;
      continue;
    }
    working.push({
      id: row.id,
      actorId: row.actor,
      verb: row.verb,
      action: describeActivity(row.verb, row.target_name, 1),
      timestamp: ts,
      count: 1,
      targetName: row.target_name,
      targetTable: table,
    });
  }
  return working.map(({ targetName: _n, targetTable: _t, ...item }) => item);
}

/** 拼一条动态的相对时间（复用 activity-panel 的格式化）。 */
export function activityRelativeTime(item: ActivityFeedItem, now?: Date): string {
  return formatRelativeTime(item.timestamp, now);
}
