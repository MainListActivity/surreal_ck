import { getRootDatabaseSession } from "../db/root-connection";
import { env } from "../env";
import type { FunnelEventName } from "./events";
import type { FunnelAggregate } from "./summary";

export type FunnelCountRow = {
  event: string;
  day: string;
  workspaceKey: string;
  count: number;
};

export type FunnelCountQuery = {
  event?: string;
  day?: string;
  limit?: number;
};

type Queryable = { query(sql: string, params?: Record<string, unknown>): Promise<unknown> };
type SessionFactory = (database: string, namespace: string) => Promise<Queryable>;

function rows(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result) && Array.isArray(result[0]) ? result[0] as Record<string, unknown>[] : [];
}

function mapRow(row: Record<string, unknown>): FunnelCountRow | null {
  const event = typeof row.event === "string" ? row.event : null;
  const day = typeof row.day === "string" ? row.day : null;
  const workspaceKey = typeof row.workspace_key === "string" ? row.workspace_key : null;
  const count = typeof row.count === "number" ? row.count : null;
  if (!event || !day || !workspaceKey || count === null) return null;
  return { event, day, workspaceKey, count };
}

export interface FunnelCountStore {
  list(query: FunnelCountQuery): Promise<FunnelCountRow[]>;
}

export type FunnelSummaryQuery = Readonly<{
  event: FunnelEventName;
  day: string;
}>;

export interface FunnelSummaryStore {
  summarize(query: FunnelSummaryQuery): Promise<FunnelAggregate>;
}

function countOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export class SurrealFunnelCountStore implements FunnelCountStore, FunnelSummaryStore {
  constructor(
    private readonly getSession: SessionFactory = getRootDatabaseSession,
    private readonly namespace = env.SURREAL_NS,
  ) {}

  async list(query: FunnelCountQuery): Promise<FunnelCountRow[]> {
    const conditions = ["1 = 1"];
    const params: Record<string, unknown> = { limit: query.limit ?? 500 };
    if (query.event) {
      conditions.push("event = $event");
      params.event = query.event;
    }
    if (query.day) {
      conditions.push("day = $day");
      params.day = query.day;
    }
    const session = await this.getSession("_system", this.namespace);
    const result = await session.query(
      `SELECT event, day, workspace_key, count FROM funnel_event_count
       WHERE ${conditions.join(" AND ")} ORDER BY day DESC, event ASC LIMIT $limit;`,
      params,
    );
    return rows(result).flatMap((row) => {
      const mapped = mapRow(row);
      return mapped ? [mapped] : [];
    });
  }

  /**
   * 数据库内按 (event, day) 聚合：只取回总数与贡献工作区数，不逐行返回
   * workspace_key，也不受 funnel-counts 的 500 行上限约束。
   */
  async summarize(query: FunnelSummaryQuery): Promise<FunnelAggregate> {
    const session = await this.getSession("_system", this.namespace);
    const result = await session.query(
      `SELECT count() AS workspace_count, math::sum(count) AS total_count
       FROM funnel_event_count WHERE event = $event AND day = $day GROUP ALL;`,
      { event: query.event, day: query.day },
    );
    const row = rows(result)[0];
    // 空窗时 GROUP ALL 仍返回一行零值；缺失行也按零处理。
    if (!row) return { totalCount: 0, workspaceCount: 0 };
    const totalCount = countOf(row.total_count);
    const workspaceCount = countOf(row.workspace_count);
    if (totalCount === null || workspaceCount === null) {
      throw new Error("funnel summary aggregate malformed");
    }
    return { totalCount, workspaceCount };
  }
}
