// 控制面 worker 环路存活性事实源（进程内）。
// 只记录环路名、计数与错误码，不落请求载荷/用户内容——/health 与
// _system 心跳表共用同一事实，QA 可区分「HTTP 正常」与「worker 正常」。

export type WorkerLoopSnapshot = Readonly<{
  loop: string;
  ok: boolean;
  ticks: number;
  skippedTicks: number;
  consecutiveErrors: number;
  timeouts: number;
  secondsSinceLastTick: number | null;
  secondsSinceLastSuccess: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  inflight: boolean;
}>;

export type WorkerLivenessSnapshot = Readonly<{
  ok: boolean;
  loops: readonly WorkerLoopSnapshot[];
}>;

type WorkerLoopStats = {
  intervalMs: number;
  freshCutoffMs: number;
  ticks: number;
  skippedTicks: number;
  consecutiveErrors: number;
  timeouts: number;
  lastTickAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  inflight: boolean;
};

const registry = new Map<string, WorkerLoopStats>();

/** 单环刚逝判据：超过 interval 的 10 倍（至少 30s）无成功 tick 视为失活。 */
function freshCutoffMs(intervalMs: number): number {
  return Math.max(intervalMs * 10, 30_000);
}

export function registerWorkerLoop(loop: string, intervalMs: number): void {
  if (!registry.has(loop)) {
    registry.set(loop, {
      intervalMs,
      freshCutoffMs: freshCutoffMs(intervalMs),
      ticks: 0,
      skippedTicks: 0,
      consecutiveErrors: 0,
      timeouts: 0,
      lastTickAt: null,
      lastSuccessAt: null,
      lastError: null,
      lastErrorAt: null,
      inflight: false,
    });
  }
}

export function beginWorkerLoopTick(loop: string): number {
  const stats = registry.get(loop);
  if (!stats) return 0;
  stats.ticks += 1;
  stats.lastTickAt = Date.now();
  stats.inflight = true;
  return stats.ticks;
}

export function skipWorkerLoopTick(loop: string): void {
  const stats = registry.get(loop);
  if (!stats) return;
  stats.skippedTicks += 1;
}

/**
 * 结算一个 tick。带 seq 时仅当它仍是该环最近一次开始且未结算的 tick 才
 * 记账——被 watchdog 放弃后迟到落地的查询不得覆盖当前记账
 * （其副作用由 DB 侧 fencing/lease 保证无害，这里只管观测事实）。
 */
export function endWorkerLoopTick(
  loop: string,
  error?: unknown,
  seq?: number,
): void {
  const stats = registry.get(loop);
  if (!stats || (seq !== undefined && seq !== stats.ticks)) return;
  stats.inflight = false;
  if (error === undefined) {
    stats.consecutiveErrors = 0;
    stats.lastSuccessAt = Date.now();
    return;
  }
  stats.consecutiveErrors += 1;
  stats.lastError = error instanceof Error ? error.name : String(typeof error);
  stats.lastErrorAt = Date.now();
}

export function recordWorkerLoopTimeout(loop: string): void {
  const stats = registry.get(loop);
  if (!stats) return;
  stats.timeouts += 1;
}

function describeAge(at: number | null, now: number): number | null {
  return at === null ? null : Math.max(0, (now - at) / 1000);
}

export function getWorkerLivenessSnapshot(): WorkerLivenessSnapshot {
  const now = Date.now();
  let ok = true;
  const loops: WorkerLoopSnapshot[] = [];
  for (const [loop, stats] of registry) {
    // 判活：无连续错误，或最近一次成功 tick 在刚逝窗口内。
    // 挂起的 tick 在 watchdog 超时后转为 consecutiveErrors，从而失活可见。
    const fresh =
      stats.lastSuccessAt !== null
      && now - stats.lastSuccessAt <= stats.freshCutoffMs;
    const alive = stats.consecutiveErrors === 0 || fresh;
    if (!alive) ok = false;
    loops.push(Object.freeze({
      loop,
      ok: alive,
      ticks: stats.ticks,
      skippedTicks: stats.skippedTicks,
      consecutiveErrors: stats.consecutiveErrors,
      timeouts: stats.timeouts,
      secondsSinceLastTick: describeAge(stats.lastTickAt, now),
      secondsSinceLastSuccess: describeAge(stats.lastSuccessAt, now),
      lastError: stats.lastError,
      lastErrorAt: stats.lastErrorAt,
      inflight: stats.inflight,
    }));
  }
  return Object.freeze({ ok, loops: Object.freeze(loops) });
}

/** 测试隔离用：清空注册表。 */
export function resetWorkerLiveness(): void {
  registry.clear();
}
