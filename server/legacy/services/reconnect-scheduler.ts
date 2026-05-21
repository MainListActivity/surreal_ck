import { reconnectRemote, getNeedsRelogin } from "./reconnect";
import { getRemoteDb } from "../db/index";

/**
 * 指数退避自动重连调度器。
 *
 * 进入离线后，按 5s → 10s → 30s → 60s → 120s（封顶）的节奏尝试恢复连接。
 * 任何一次成功（remote 重新建立）即停止；refresh_token 失效（needs-relogin）
 * 进入终态，停止自动重试，等待用户重新登录。
 *
 * 设计目标是「无副作用地多次调用 schedule/stop」：
 * - schedule() 时若已有 timer 不重置；若已在线/已 needs-relogin 立即返回
 * - reportConnected() 在 connectRemote 成功后调用，重置退避并停止 timer
 * - reportNeedsRelogin() 进入终态，等待用户登录后由调用方 clearNeedsRelogin()
 */
const BACKOFF_SEQUENCE_MS = [5_000, 10_000, 30_000, 60_000, 120_000];

let timer: ReturnType<typeof setTimeout> | null = null;
let attemptIndex = 0;
let nextRetryAt: number | null = null;

type Listener = (info: { nextRetryAt: number | null }) => void;
const listeners = new Set<Listener>();

function notify() {
  for (const listener of listeners) {
    listener({ nextRetryAt });
  }
}

function clearTimer() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  nextRetryAt = null;
}

function nextDelayMs(): number {
  const index = Math.min(attemptIndex, BACKOFF_SEQUENCE_MS.length - 1);
  return BACKOFF_SEQUENCE_MS[index]!;
}

async function tick() {
  timer = null;
  nextRetryAt = null;
  notify();

  if (getRemoteDb()) {
    attemptIndex = 0;
    return;
  }
  if (getNeedsRelogin()) {
    return;
  }

  const outcome = await reconnectRemote();
  if (outcome.status === "reconnected") {
    attemptIndex = 0;
    return;
  }
  if (outcome.status === "needs-relogin") {
    return;
  }

  attemptIndex += 1;
  scheduleReconnect();
}

/** 在还没排程时安排下一次重连。已排程或在线或终态时无副作用。 */
export function scheduleReconnect(): void {
  if (timer) return;
  if (getRemoteDb()) return;
  if (getNeedsRelogin()) return;

  const delay = nextDelayMs();
  nextRetryAt = Date.now() + delay;
  timer = setTimeout(() => {
    void tick();
  }, delay);
  notify();
}

/** 立即触发一次重连，不等待退避。如果当前在线或终态则跳过。 */
export async function reconnectNow(): Promise<void> {
  clearTimer();
  if (getRemoteDb()) {
    attemptIndex = 0;
    return;
  }
  if (getNeedsRelogin()) return;

  const outcome = await reconnectRemote();
  if (outcome.status === "reconnected") {
    attemptIndex = 0;
    return;
  }
  if (outcome.status === "needs-relogin") {
    return;
  }
  attemptIndex += 1;
  scheduleReconnect();
}

/** connectRemote 成功后调用，重置退避状态。 */
export function reportConnected(): void {
  clearTimer();
  attemptIndex = 0;
  notify();
}

/** 登录/登出后调用：清理调度，重置退避。 */
export function stopReconnect(): void {
  clearTimer();
  attemptIndex = 0;
  notify();
}

export function getNextRetryAt(): number | null {
  return nextRetryAt;
}

export function subscribeReconnect(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetReconnectSchedulerForTests(): void {
  clearTimer();
  attemptIndex = 0;
  listeners.clear();
}
