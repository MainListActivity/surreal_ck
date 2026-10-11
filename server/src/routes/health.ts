import { Hono } from "hono";
import { checkRootConnection } from "../db/root-connection";
import { getWorkerLivenessSnapshot } from "../quota/worker-liveness";
import type { AppBindings } from "../hono-types";

const startedAt = Date.now();

export type HealthRoutesDeps = {
  /** 生产用真实 root 连接探测；测试注入可控实现。 */
  checkRootConnection?: (timeoutMs?: number) => Promise<boolean>;
};

/**
 * /health 如实反映 root 连接**当前真实状态**：探测先实测现有连接（半开探测），
 * 失败才单飞重连并按结果报告——瞬断自愈、真实降级如实 down，绝不常 ok。
 */
export function createHealthRoutes(deps: HealthRoutesDeps = {}) {
  const checkRoot = deps.checkRootConnection ?? checkRootConnection;
  const routes = new Hono<AppBindings>();

  routes.get("/health", async (c) => {
    const surrealUp = await checkRoot(5000);
    // worker 存活性与 DB 可达性分开报告：控制面环路挂起/连续报错时
    // status 仍由 DB 决定，但 quotaWorker.ok=false 让部署验收与 QA
    // 不再把「/health 正常」误读为「worker 正常」。
    const worker = getWorkerLivenessSnapshot();

    return c.json({
      status: surrealUp ? "ok" : "degraded",
      surrealdb: surrealUp ? "up" : "down",
      quotaWorker: {
        ok: worker.ok,
        loops: worker.loops.map((loop) => ({
          loop: loop.loop,
          ok: loop.ok,
          ticks: loop.ticks,
          secondsSinceLastSuccess: loop.secondsSinceLastSuccess,
          consecutiveErrors: loop.consecutiveErrors,
          lastError: loop.lastError,
        })),
      },
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    });
  });

  return routes;
}

export const healthRoutes = createHealthRoutes();
