import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getWorkerLivenessSnapshot,
  resetWorkerLiveness,
} from "./worker-liveness";
import { startQuotaLoop } from "./sweeps";

// setInterval 用手动触发器：单测里显式推进 tick，避免真实计时。
function manualInterval() {
  let handler: (() => void) | undefined;
  return {
    setInterval: (fn: () => void) => {
      handler = fn;
      return 0;
    },
    clearInterval: () => {
      handler = undefined;
    },
    fire: () => handler?.(),
    get active() {
      return handler !== undefined;
    },
  };
}

describe("quota worker loop liveness", () => {
  beforeEach(() => resetWorkerLiveness());
  afterEach(() => resetWorkerLiveness());

  test("成功 tick 记账为存活；报错递增 consecutiveErrors 并保留错误名", async () => {
    const timer = manualInterval();
    let calls = 0;
    const loop = startQuotaLoop({
      name: "unit-loop",
      runOnce: async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
      },
      intervalMs: 10,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });

    timer.fire(); // 第一次手动 tick：构造时那次已挂起（微任务未落地）→ 跳过
    await Bun.sleep(5); // 构造 tick 的报错此时结算
    let snapshot = getWorkerLivenessSnapshot().loops[0];
    expect(snapshot.loop).toBe("unit-loop");
    expect(snapshot.consecutiveErrors).toBe(1);
    expect(snapshot.lastError).toBe("Error");
    expect(snapshot.ok).toBe(false); // 报过错且从未成功 → 失活可见

    timer.fire(); // 第二次 tick：成功
    await Bun.sleep(5);
    snapshot = getWorkerLivenessSnapshot().loops[0];
    expect(snapshot.consecutiveErrors).toBe(0);
    expect(snapshot.secondsSinceLastSuccess).toBeLessThan(1);
    loop.stop();
    expect(timer.active).toBe(false);
  });

  test("挂起的 runOnce 防重入：后续 tick 跳过且不叠加查询", async () => {
    const timer = manualInterval();
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loop = startQuotaLoop({
      name: "unit-hang",
      runOnce: () => {
        calls += 1;
        return gate;
      },
      intervalMs: 10,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
      tickTimeoutMs: 5_000,
    });

    timer.fire();
    expect(calls).toBe(1);
    timer.fire();
    timer.fire();
    expect(calls).toBe(1); // 未落地不叠加
    const snapshot = getWorkerLivenessSnapshot().loops[0];
    expect(snapshot.inflight).toBe(true);
    expect(snapshot.skippedTicks).toBe(3);
    release?.();
    loop.stop();
  });

  test("watchdog 超时：挂起 tick 按超时记账，环路恢复推进", async () => {
    const timer = manualInterval();
    let calls = 0;
    let rejectFirst: ((reason: Error) => void) | undefined;
    const hang = new Promise<never>((_, reject) => {
      rejectFirst = reject;
    });
    const errors: unknown[] = [];
    const loop = startQuotaLoop({
      name: "unit-timeout",
      runOnce: () => {
        calls += 1;
        return calls === 1 ? hang : Promise.resolve("ok");
      },
      intervalMs: 10,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
      tickTimeoutMs: 20,
      onError: (error) => errors.push(error),
    });

    timer.fire(); // 挂起
    await Bun.sleep(60); // 超时触发
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("quota_loop_tick_timeout");
    let snapshot = getWorkerLivenessSnapshot().loops[0];
    expect(snapshot.timeouts).toBe(1);
    expect(snapshot.consecutiveErrors).toBe(1);
    expect(snapshot.ok).toBe(false); // 从未成功且已报错 → 失活可见

    timer.fire(); // 恢复：新 tick 可推进
    expect(calls).toBe(2);
    await Bun.sleep(5);
    snapshot = getWorkerLivenessSnapshot().loops[0];
    expect(snapshot.ok).toBe(true);
    expect(snapshot.consecutiveErrors).toBe(0);
    // 迟到的挂起查询落地不炸进程（fencing 保证其结算无副作用）
    rejectFirst?.(new Error("late settle"));
    await Bun.sleep(5);
    loop.stop();
  });
});
