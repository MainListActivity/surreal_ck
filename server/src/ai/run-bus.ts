/**
 * 进程内事件总线：把一次 router workflow run 的运行过程事件（progress / chunk /
 * suspend / done / error）从 workflow 侧投递给监听该 runId 的 WS 订阅者。
 *
 * - workflow 侧（生产 AiChatService 内）调 `publish(runId, event)`。
 * - WS endpoint 握手通过后调 `subscribe(runId, listener)`：先回放该 runId 此前
 *   缓存的全部事件，再接后续——客户端断网重连不丢历史（issue D1-05 验收）。
 * - done / error 为终态：发布后短 TTL 内仍保留缓存供迟到订阅重放，过后清理。
 *
 * 推送的是 workflow **运行过程**，不是数据库行变更；数据行变更由浏览器直连
 * SurrealDB 的 LIVE SELECT 订阅，不经过本总线。MVP 单进程内存即可。
 */

import { CHAT_STREAM_TERMINAL_RETENTION_MS, type ChatStreamEvent } from "@surreal-ck/shared";

export type RunBusListener = (event: ChatStreamEvent) => void;

export type RunBus = {
  /** workflow 侧投递一条事件；缓存进该 runId 的回放缓冲，并广播给当前订阅者。 */
  publish(runId: string, event: ChatStreamEvent): void;
  /** 订阅一个 runId：先回放已缓存事件，再接后续。返回取消订阅函数。 */
  subscribe(runId: string, listener: RunBusListener): () => void;
};

type RunChannel = {
  backlog: ChatStreamEvent[];
  listeners: Set<RunBusListener>;
  /** done / error 发布时刻；越过此刻 + 保留窗口后该 channel 可被清理。undefined = 仍在跑。 */
  terminalAt?: number;
};

function isTerminal(event: ChatStreamEvent): boolean {
  return event.kind === "done" || event.kind === "error";
}

export function createRunBus(now: () => number = Date.now): RunBus {
  const channels = new Map<string, RunChannel>();

  /** 取 channel；若已越过终态保留窗口则先丢弃旧 channel（迟到订阅拿不到历史）。 */
  function channel(runId: string): RunChannel {
    const existing = channels.get(runId);
    if (existing?.terminalAt !== undefined && now() > existing.terminalAt + CHAT_STREAM_TERMINAL_RETENTION_MS) {
      channels.delete(runId);
    }
    let ch = channels.get(runId);
    if (!ch) {
      ch = { backlog: [], listeners: new Set() };
      channels.set(runId, ch);
    }
    return ch;
  }

  return {
    publish(runId, event) {
      const ch = channel(runId);
      ch.backlog.push(event);
      if (isTerminal(event)) ch.terminalAt = now();
      for (const listener of ch.listeners) listener(event);
    },

    subscribe(runId, listener) {
      const ch = channel(runId);
      for (const event of ch.backlog) listener(event);
      ch.listeners.add(listener);
      return () => {
        ch.listeners.delete(listener);
      };
    },
  };
}
