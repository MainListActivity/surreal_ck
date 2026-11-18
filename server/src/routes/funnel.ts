import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requirePlatformOperator } from "../ops/operator-auth";
import { isFunnelEventName } from "../funnel/events";
import { buildFunnelSummary, isUtcDay } from "../funnel/summary";
import {
  SurrealFunnelCountStore,
  type FunnelCountStore,
  type FunnelSummaryStore,
} from "../funnel/store";

/**
 * 漏斗计数只读端点（任务 d70c3748 第 4 版 §6 的读取路径）。
 *
 * 运营身份需持 funnel.read 能力（PLATFORM_OPERATOR_CAPABILITIES）；行内只有事件名、
 * 日期、HMAC 工作区标识与计数，不含任何内容字段。仅 GET，不提供写回。
 *
 * /api/ops/funnel-summary 是固定事件 + 固定 UTC 日的聚合视图：在数据库内按
 * (event, day) 汇总，只返回总量与贡献工作区数，不返回 workspace_key，也不受
 * funnel-counts 的 500 行逐条上限影响。低样本固定抑制，空窗与覆盖未知分开标记。
 */
export function createFunnelRoutes(input: Readonly<{
  store?: FunnelCountStore;
  summaryStore?: FunnelSummaryStore;
  requireOperator?: () => MiddlewareHandler<AppBindings>;
}> = {}) {
  const requireOperator = input.requireOperator ?? (() => requirePlatformOperator("funnel.read"));
  const store = input.store ?? new SurrealFunnelCountStore();
  const summaryStore = input.summaryStore ?? new SurrealFunnelCountStore();

  return new Hono<AppBindings>()
    .get("/api/ops/funnel-counts", requireOperator(), async (c) => {
      const url = new URL(c.req.url);
      const event = url.searchParams.get("event") ?? undefined;
      const day = url.searchParams.get("day") ?? undefined;
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw === null ? undefined : Number.parseInt(limitRaw, 10);
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0 || limit > 500)) {
        throw new HttpError(422, "funnel-counts-invalid-limit", "limit 须为 1–500 的整数");
      }
      return c.json({
        counts: await store.list({ event, day, limit }),
      });
    })
    .get("/api/ops/funnel-summary", requireOperator(), async (c) => {
      const url = new URL(c.req.url);
      const seen = new Set<string>();
      for (const key of url.searchParams.keys()) {
        if ((key !== "event" && key !== "day") || seen.has(key)) {
          throw new HttpError(422, "funnel-summary-invalid-query", "只接受固定的 event 与 day 参数");
        }
        seen.add(key);
      }
      const event = url.searchParams.get("event");
      const day = url.searchParams.get("day");
      if (!event || !isFunnelEventName(event)) {
        throw new HttpError(422, "funnel-summary-invalid-event", "event 须为已定义的漏斗事件");
      }
      if (!day || !isUtcDay(day)) {
        throw new HttpError(422, "funnel-summary-invalid-day", "day 须为合法 UTC 日期（YYYY-MM-DD）");
      }
      try {
        return c.json(buildFunnelSummary(event, day, await summaryStore.summarize({ event, day })));
      } catch (error) {
        // 上游错误正文不外发；运营侧只看到固定分类。
        console.error("[funnel] summary query failed", {
          event,
          day,
          message: error instanceof Error ? error.message : String(error),
        });
        throw new HttpError(502, "funnel-summary-upstream-unavailable", "汇总源暂不可用");
      }
    });
}
