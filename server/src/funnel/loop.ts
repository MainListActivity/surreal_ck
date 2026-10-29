import { env } from "../env";
import { aggregateFunnelCounts, type FunnelAggregationClient } from "./aggregator";
import { createRootSessionSource } from "../db/root-connection";

export type FunnelLoopHandle = {
  stop(): void;
};

export type StartFunnelLoopOptions = {
  intervalSec?: number;
  /** 单轮聚合动作；默认绑定 aggregateFunnelCounts（root 会话）。失败会被吞掉，不影响心跳。 */
  runOnce?: () => Promise<unknown>;
  // 定时器 handle 不约束具体类型（Bun Timer vs node Timeout 签名不一），用 unknown 解耦。
  setInterval?: (handler: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
};

/** 与 _system index 校对心跳同型：启动立即跑一次，按周期重复，单轮失败吞掉等下个 tick。 */
export function startFunnelLoop(options: StartFunnelLoopOptions = {}): FunnelLoopHandle {
  const intervalSec = options.intervalSec ?? env.RECONCILE_INTERVAL_SEC;
  const runOnce = options.runOnce ?? (async () => {
    const session = await createRootSessionSource().newSession() as unknown as FunnelAggregationClient & {
      closeSession(): Promise<unknown>;
    };
    try {
      return await aggregateFunnelCounts(session, { hashKey: env.FUNNEL_HASH_KEY ?? "" });
    } finally {
      await session.closeSession();
    }
  });
  const setIntervalFn: (handler: () => void, ms: number) => unknown =
    options.setInterval ?? ((handler, ms) => setInterval(handler, ms));
  const clearIntervalFn: (handle: unknown) => void =
    options.clearInterval ?? ((handle) => clearInterval(handle as Parameters<typeof clearInterval>[0]));

  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void Promise.resolve()
      .then(runOnce)
      .catch((cause) => {
        console.error("[funnel] aggregation run failed; will retry next tick", {
          message: cause instanceof Error ? cause.message : String(cause),
        });
      })
      .finally(() => { running = false; });
  };

  // 启动立即跑一次（不阻塞 boot）。
  tick();

  const handle = setIntervalFn(tick, intervalSec * 1000);

  return {
    stop() {
      clearIntervalFn(handle);
    },
  };
}
