/**
 * 漏斗埋点聚合任务（任务 d70c3748 第 4 版 §2、§3、§6）。
 *
 * 每个 active 工作区库读取 funnel_event 原始行（059-funnel-event.surql 的 DEFINE EVENT
 * 落行），按 (event, day) 精确重算计数；return_week2 从 activity_event 的 record.write
 * 与 first_success 日推算（本地自然日差 7–13，activation-outcomes.ts:194 口径）；invite_issued
 * 从 _system.ops_invitation 的 completed 行按 created_at 日期聚合。结果 UPSERT 进
 * _system.funnel_event_count（040），count 恒等于重算值——重复执行幂等，不做增量累加。
 *
 * 行只写事件名、日期、HMAC 工作区标识与计数；不写任何内容字段（方案 §4 禁止采集清单）。
 */

import { workspaceKey } from "./hash";

export type FunnelAggregationClient = {
  use(scope: { namespace: string; database: string }): Promise<unknown>;
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

export type FunnelEventName =
  | "invite_issued"
  | "first_login"
  | "template_created"
  | "import_succeeded"
  | "first_success"
  | "ai_proposal_adopted"
  | "return_week2";

export type FunnelAggregationResult = {
  workspaces: number;
  computed: number;
  written: number;
  skippedNoHashKey: boolean;
  failedWorkspaces: string[];
};

type WorkspaceRow = { dbName: string; slug: string };

type RawFunnelRow = { event?: unknown; day?: unknown };

export type FunnelAggregationOptions = {
  namespace?: string;
  hashKey: string;
};

const FIRST_SUCCESS_WINDOW_START_DAYS = 7;
/** 窗口为本地自然日差 7–13（activation-outcomes.ts:194 的 day >= 7 && day <= 13）。 */
const FIRST_SUCCESS_WINDOW_END_DAYS = 13;

function rowsOf(result: unknown): unknown[] {
  const first = Array.isArray(result) ? result[0] : undefined;
  return Array.isArray(first) ? first : [];
}

/** SDK 边界的 datetime → ISO 字符串（见 db/surreal-values 的同类处理）。 */
function isoOf(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && "toString" in value) {
    const text = String(value);
    return Number.isNaN(Date.parse(text)) ? null : text;
  }
  return null;
}

/** "YYYY-MM-DD"（UTC）日期差：right - left，单位天。 */
export function dayDiff(left: string, right: string): number {
  const a = Date.parse(`${left}T00:00:00Z`);
  const b = Date.parse(`${right}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  return Math.round((b - a) / 86_400_000);
}

function addDays(day: string, days: number): string {
  const base = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(base)) return day;
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

export function readWorkspaces(result: unknown): WorkspaceRow[] {
  return rowsOf(result).flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    const dbName = typeof row.db_name === "string" ? row.db_name : null;
    const slug = typeof row.slug === "string" ? row.slug : null;
    return dbName && slug ? [{ dbName, slug }] : [];
  });
}

/** (event, day) → 精确计数；重复行（应被 059 的幂等约束排除）如出现会如实计入。 */
export function countFunnelRows(rows: RawFunnelRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const event = typeof row.event === "string" ? row.event : null;
    const day = typeof row.day === "string" ? row.day : null;
    if (!event || !day) continue;
    const key = `${event}|${day}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** 首个 first_success 日（最早 day）；无则 null。 */
export function firstSuccessDay(rows: RawFunnelRow[]): string | null {
  const days = rows
    .filter((row): row is { event: "first_success"; day: string } =>
      !!row && typeof row === "object"
      && (row as RawFunnelRow).event === "first_success"
      && typeof (row as RawFunnelRow).day === "string")
    .map((row) => row.day)
    .sort();
  return days[0] ?? null;
}

/**
 * return_week2 的暂行口径：first_success 日起本地自然日差 7–13 内存在 record.write
 * 活动，取最早命中活动的日期作为计数日。窗口跨天，聚合任务每轮重算。
 */
export function returnWeek2Day(firstSuccess: string, writeDays: readonly string[]): string | null {
  const hits = [...writeDays]
    .filter((day) => {
      const diff = dayDiff(firstSuccess, day);
      return diff >= FIRST_SUCCESS_WINDOW_START_DAYS && diff <= FIRST_SUCCESS_WINDOW_END_DAYS;
    })
    .sort();
  return hits[0] ?? null;
}

type ComputedCount = { event: FunnelEventName; day: string; workspaceHashInput: string; count: number };

export async function aggregateFunnelCounts(
  client: FunnelAggregationClient,
  options: FunnelAggregationOptions,
): Promise<FunnelAggregationResult> {
  const namespace = options.namespace ?? "main";
  const result: FunnelAggregationResult = {
    workspaces: 0,
    computed: 0,
    written: 0,
    skippedNoHashKey: false,
    failedWorkspaces: [],
  };

  await client.use({ namespace, database: "_system" });
  const workspaces = readWorkspaces(
    await client.query("SELECT id, db_name, slug FROM workspace WHERE status = 'active';"),
  );
  result.workspaces = workspaces.length;
  const dbNameBySlug = new Map(workspaces.map((workspace) => [workspace.slug, workspace.dbName]));
  const computed: ComputedCount[] = [];

  // invite_issued：_system.ops_invitation 的 completed 行按（日, 工作区）聚合；
  // 工作区标识按 slug → db_name 解析，工作区已不存在时退回用 slug 作哈希输入（口径差异见交付说明）。
  const inviteCounts = new Map<string, number>();
  const rows = rowsOf(
    await client.query("SELECT created_at, workspace_slug FROM ops_invitation WHERE status = 'completed';"),
  );
  for (const value of rows) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const createdAt = isoOf(row.created_at);
    const slug = typeof row.workspace_slug === "string" ? row.workspace_slug : null;
    if (!createdAt || !slug) continue;
    const key = `${dayOfIso(createdAt)}|${slug}`;
    inviteCounts.set(key, (inviteCounts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of inviteCounts) {
    const [day, slug] = key.split("|");
    // 工作区行已不存在（如已删除）时退回用 `slug:<slug>` 作哈希输入：与 db_name
    // 分属不同命名域，避免同一工作区的历史分裂成两个 workspace_key（评审观察）。
    computed.push({
      event: "invite_issued",
      day: day!,
      workspaceHashInput: dbNameBySlug.get(slug!) ?? `slug:${slug}`,
      count,
    });
  }

  for (const workspace of workspaces) {
    try {
      await client.use({ namespace, database: workspace.dbName });
      const funnelRows: RawFunnelRow[] = rowsOf(
        await client.query("SELECT event, day, subject FROM funnel_event;"),
      ).filter((value): value is RawFunnelRow => !!value && typeof value === "object");
      for (const [key, count] of countFunnelRows(funnelRows)) {
        const [event, day] = key.split("|");
        computed.push({
          event: event as FunnelEventName,
          day: day!,
          workspaceHashInput: workspace.dbName,
          count,
        });
      }

      const successDay = firstSuccessDay(funnelRows);
      if (successDay) {
        // 窗口 [day+7, day+13]；上界取 day+14 0 点为排他边界（等价 +13 全天）。
        const windowStartIso = `${addDays(successDay, FIRST_SUCCESS_WINDOW_START_DAYS)}T00:00:00Z`;
        const windowEndIso = `${addDays(successDay, FIRST_SUCCESS_WINDOW_END_DAYS + 1)}T00:00:00Z`;
        const writeDays = rowsOf(
          await client.query(
            "SELECT VALUE time::format(created_at, \"%Y-%m-%d\") AS day FROM activity_event WHERE verb = \"record.write\" AND created_at >= <datetime>$startIso AND created_at < <datetime>$endIso;",
            { startIso: windowStartIso, endIso: windowEndIso },
          ),
        ).filter((value): value is string => typeof value === "string");
        const returnDay = returnWeek2Day(successDay, writeDays);
        if (returnDay) {
          computed.push({
            event: "return_week2",
            day: returnDay,
            workspaceHashInput: workspace.dbName,
            count: 1,
          });
        }
      }
    } catch (cause) {
      // 单个工作区不可达不阻塞整轮聚合，记入失败清单，下个周期重试。
      result.failedWorkspaces.push(workspace.dbName);
      console.error("[funnel] workspace aggregation failed; skipping", {
        dbName: workspace.dbName,
        message: cause instanceof Error ? cause.message : String(cause),
      });
      try {
        await client.use({ namespace, database: "_system" });
      } catch {
        // 连切回 _system 都失败说明 root 连接整体异常，留给下个周期处理。
      }
    }
  }

  result.computed = computed.length;

  // 工作区标识哈希：无密钥时不得写入（hash.ts 的不可逆要求），只返回重算结果。
  if (!options.hashKey) {
    result.skippedNoHashKey = true;
    return result;
  }

  await client.use({ namespace, database: "_system" });
  for (const item of computed) {
    const key = workspaceKey(item.workspaceHashInput, options.hashKey);
    if (!key) continue;
    await client.query(
      "INSERT INTO funnel_event_count { event: $event, day: $day, workspace_key: $workspaceKey, count: $count } ON DUPLICATE KEY UPDATE count = $count, updated_at = time::now();",
      { event: item.event, day: item.day, workspaceKey: key, count: item.count },
    );
    result.written += 1;
  }
  return result;
}

function dayOfIso(iso: string): string {
  return iso.slice(0, 10);
}
