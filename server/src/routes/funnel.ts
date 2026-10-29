import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requirePlatformOperator } from "../ops/operator-auth";
import { SurrealFunnelCountStore, type FunnelCountStore } from "../funnel/store";

/**
 * 漏斗计数只读端点（任务 d70c3748 第 4 版 §6 的读取路径）。
 *
 * 运营身份需持 funnel.read 能力（PLATFORM_OPERATOR_CAPABILITIES）；行内只有事件名、
 * 日期、HMAC 工作区标识与计数，不含任何内容字段。仅 GET，不提供写回。
 */
export function createFunnelRoutes(input: Readonly<{
  store?: FunnelCountStore;
  requireOperator?: () => MiddlewareHandler<AppBindings>;
}> = {}) {
  const requireOperator = input.requireOperator ?? (() => requirePlatformOperator("funnel.read"));
  const store = input.store ?? new SurrealFunnelCountStore();

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
    });
}
