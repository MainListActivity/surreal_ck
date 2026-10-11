import { Hono } from "hono";
import { checkRootConnection } from "../db/root-connection";
import { checkHealthProbe } from "../db/health-probe";
import { getWorkerLivenessSnapshot } from "../quota/worker-liveness";
import type { AppBindings } from "../hono-types";

const startedAt = Date.now();

export type HealthRoutesDeps = {
  /** 生产用真实 root 连接探测；测试注入可控实现。 */
  checkRootConnection?: (timeoutMs?: number) => Promise<boolean>;
  /** 生产用 /health 专用探测连接；测试注入可控实现。 */
  checkHealthProbe?: (timeoutMs?: number) => Promise<boolean>;
};

/**
 * /health 如实反映 surrealdb **当前真实可达性**：探测连接（/health 专用，
 * 受控演练的断开对象）与业务 root 连接（session pool / quotaWorker）任一
 * 实测失败即如实 down——半开探测、失败才单飞重连并按结果报告，瞬断自愈、
 * 真实降级如实 down，绝不常 ok。
 */
export function createHealthRoutes(deps: HealthRoutesDeps = {}) {
  const checkRoot = deps.checkRootConnection ?? checkRootConnection;
  const checkProbe = deps.checkHealthProbe ?? checkHealthProbe;
  const routes = new Hono<AppBindings>();

  routes.get("/health", async (c) => {
    // 并行实测两条连接：探测连接（演练目标）+ 业务 root 连接，各自 5s 预算。
    const [probeUp, rootUp] = await Promise.all([
      checkProbe(5000),
      checkRoot(5000),
    ]);
    const surrealUp = probeUp && rootUp;
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
