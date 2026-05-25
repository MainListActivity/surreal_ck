/**
 * 进程内 run 注册表：记录每个 router workflow run 的 owner 与短期 stream token。
 *
 * - POST /api/chat 启动 run 时 `register()` 一条记录并 mint streamToken（TTL 5 分钟）。
 * - 簇 D1-05 的 WS endpoint 用 `resolveStreamToken()` 校验 token 指向的 runId 与调用者归属，
 *   再从 RunBus 取事件（RunBus 在 05 落地，本注册表只管 owner + token 生命周期）。
 *
 * MVP 单进程内存即可；多副本时改外部存储（不在 D1-04 范围）。
 */

export const STREAM_TOKEN_TTL_MS = 5 * 60 * 1000;

export type RunRecord = {
  runId: string;
  ownerSubject: string;
  streamToken: string;
  expiresAt: number;
};

export type RunRegistry = {
  /** 注册一个新 run；返回 mint 出的 streamToken。 */
  register(input: { runId: string; ownerSubject: string }): { streamToken: string };
  /** 按 runId 取记录（resume / owner 校验用）；不存在或已过期返回 undefined。 */
  get(runId: string): RunRecord | undefined;
  /** WS 握手：streamToken + runId 同时匹配且未过期才返回记录。 */
  resolveStreamToken(input: { runId: string; streamToken: string }): RunRecord | undefined;
};

export function createRunRegistry(now: () => number = Date.now): RunRegistry {
  const runs = new Map<string, RunRecord>();

  function live(record: RunRecord | undefined): RunRecord | undefined {
    if (!record) return undefined;
    if (record.expiresAt <= now()) {
      runs.delete(record.runId);
      return undefined;
    }
    return record;
  }

  return {
    register({ runId, ownerSubject }) {
      const streamToken = crypto.randomUUID().replace(/-/g, "");
      runs.set(runId, { runId, ownerSubject, streamToken, expiresAt: now() + STREAM_TOKEN_TTL_MS });
      return { streamToken };
    },

    get(runId) {
      return live(runs.get(runId));
    },

    resolveStreamToken({ runId, streamToken }) {
      const record = live(runs.get(runId));
      if (!record || record.streamToken !== streamToken) return undefined;
      return record;
    },
  };
}
