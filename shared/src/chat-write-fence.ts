/**
 * 提案确认写栅栏的共享契约（PG-1 生产实测阻断缺陷修复）。
 *
 * 背景：AI 提案卡确认过去是「浏览器无约束直写 + resume」，写栅栏只是卡片实例的内存
 * 标志。run 终态 success 后，另一标签页恢复出的同 run 暂停卡二次确认时看不见该标志，
 * 于是真实写入了业务行。本模块定义服务端栅栏所需的全部共享词汇：
 *
 * - {@link suspendPathKey}：一次 suspend 的稳定标识。同一 run 的每一次暂停必须彼此
 *   可区分（stepId + run 内递增序号），同一次 suspend 从 stream 与持久态各来一次时
 *   必须恒等——它是 exactly-once 消费与前端去重粒度的共同基准。
 * - {@link CHAT_WRITE_FENCE_ERRORS}：栅栏拒绝的具名错误码（不再静默成功）。
 *
 * 契约本身是纯函数 + 常量，不含 IO；服务端用它算键、判状态，前端用它去重和翻错误。
 */

/**
 * 一次 suspend 的路径键格式：`${stepId}#${seq}`（如 `execute-one#0`）。
 *
 * - stepId：Mastra 的挂起步（router workflow 恒为 `execute-one`，收尾补检索时为 `finalize`）。
 * - seq：**run 内挂起次数的递增序号**（`RouterState.suspendSeq`，随 workflow state 持久化）。
 *
 * 序号为什么不用 plan cursor：同一个 plan item 在 resume 后可能再次 suspend（例如研究
 * 授权变化后重新提问），按 cursor 生成键会让第二次挂起撞上已消费的那一行——栅栏永不重开，
 * 卡片永久无法确认。用递增计数则「逐次暂停唯一」，同时因为它被持久化，同一次暂停在
 * stream 事件与 recover 还原两侧算出的键必然恒等。
 *
 * 序号缺失（老 run、历史数据）时按 0 归一：那次暂停退化成 `#0`，不丢可用性。
 */
export function suspendPathKey(stepId: string, seq: number): string {
  const step = stepId.trim() || "execute-one";
  const index = Number.isFinite(seq) && seq > 0 ? Math.trunc(seq) : 0;
  return `${step}#${index}`;
}

/**
 * 当前被挂起的那次暂停的路径键。
 *
 * 优先读持久快照里 `suspendPayload.suspendKey`（权威，同源三处）；老快照缺该字段时
 * 退回按 foreachIndex 取最大游标（见 {@link suspendPathKeyFromSnapshot}）。
 */
export function suspendPathKeyFromState(input: {
  stepId?: string;
  iteration?: number;
  cursor?: number;
  state?: unknown;
}): string {
  const fromState = suspendPathKeyFromSnapshot(input.state);
  if (fromState) return fromState;
  return suspendPathKey(input.stepId ?? "execute-one", input.iteration ?? input.cursor ?? 0);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * 从一个 step 的序列化结果数组里取「最新那次 suspend」的权威键。
 *
 * 权威来源是 `suspendPayload.suspendKey`——router workflow 在挂起前写进去的，与
 * stream 事件、`chat_write_fence.suspend_path` 三处同源。缺失（本次发布之前的历史 run）
 * 才退回旧算法：按 foreachIndex 取最大游标。
 */
function suspendKeyFromStepResult(result: unknown): { key?: string; index: number } | undefined {
  const items = Array.isArray(result) ? result : [result];
  let best: { key?: string; index: number } | undefined;
  let keyHit: { key: string; index: number } | undefined;
  for (const item of items) {
    const record = asRecord(item);
    if (record?.status !== "suspended" || record.suspendPayload == null) continue;
    const payloadKey = asRecord(parseMaybeJson(record.suspendPayload))?.suspendKey;
    const index = Number(record.foreachIndex ?? record.index ?? Number.NaN);
    const rank = Number.isFinite(index) ? index : 0;
    if (typeof payloadKey === "string" && payloadKey) {
      if (!keyHit || rank >= keyHit.index) keyHit = { key: payloadKey, index: rank };
    }
    if (!best || rank >= best.index) best = { index: rank };
  }
  // 有权威键就只用它：多个 suspended 结果并存时，Mastra 的 suspendedPaths 才是当前挂起项，
  // 但键全局唯一，按 suspendedAt 最新的那次即当前挂起。
  if (keyHit) return keyHit;
  return best;
}

/** 快照 → 路径键；无任何 suspended 痕迹时返回 undefined。 */
export function suspendPathKeyFromSnapshot(state: unknown): string | undefined {
  const root = asRecord(parseMaybeJson(state));
  const context = asRecord(root?.context);
  if (!context) return undefined;

  const candidates: Array<{ stepId: string; key?: string; index: number; suspendedAt: number }> = [];
  for (const [stepId, value] of Object.entries(context)) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      const record = asRecord(item);
      if (record?.status !== "suspended" || record.suspendPayload == null) continue;
      const found = suspendKeyFromStepResult(item);
      if (!found) continue;
      candidates.push({
        stepId,
        ...(found.key ? { key: found.key } : {}),
        index: found.index,
        suspendedAt: Number(asRecord(item)?.suspendedAt ?? 0),
      });
    }
  }
  if (candidates.length === 0) return undefined;
  const latest = candidates.reduce((a, b) => (b.suspendedAt > a.suspendedAt ? b : a));
  if (latest.key) return latest.key;
  // 老快照：按游标 + stepId 兜底，仍能区分同 run 的不同 plan item 暂停。
  return suspendPathKey(
    latest.stepId,
    candidates.reduce((a, b) => (b.index > a.index ? b : a)).index,
  );
}

/**
 * 栅栏拒绝的具名错误码。三种状态各自具名，客户端据此给稳定文案，不静默成功：
 * - `chat-write-fence-consumed`：该 suspend 已被消费（另一标签页 / 恢复卡已确认过）。
 * - `chat-write-fence-run-ended`：run 已到终态（success / failed / cancelled）。
 * - `chat-write-fence-not-found`：该 run 当前没有等待中的对应决策。
 */
export const CHAT_WRITE_FENCE_ERRORS = {
  consumed: "chat-write-fence-consumed",
  runEnded: "chat-write-fence-run-ended",
  notPending: "chat-write-fence-not-pending",
} as const;

export type ChatWriteFenceErrorCode = (typeof CHAT_WRITE_FENCE_ERRORS)[keyof typeof CHAT_WRITE_FENCE_ERRORS];

const FENCE_MESSAGES: Record<ChatWriteFenceErrorCode, string> = {
  [CHAT_WRITE_FENCE_ERRORS.consumed]: "这项确认已被处理，本次没有写入任何数据。",
  [CHAT_WRITE_FENCE_ERRORS.runEnded]: "该次 AI 运行已结束，本次没有写入任何数据。",
  [CHAT_WRITE_FENCE_ERRORS.notPending]: "这项确认已失效，本次没有写入任何数据。",
};

/** 栅栏拒绝 → 用户可读中文文案（前端卡片直接展示，不显示内部错误细节）。 */
export function chatWriteFenceMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return FENCE_MESSAGES[code as ChatWriteFenceErrorCode] ?? null;
}
