import { Electroview } from "electrobun/view";
import type { AiMessageChunkEvent, AppRPC } from "../../shared/rpc.types";
import { applyAuthState } from "./auth.svelte";

let _rows: ((rows: { id: string; name: string; value: string }[]) => void) | null = null;

export function onPushRows(cb: (rows: { id: string; name: string; value: string }[]) => void) {
  _rows = cb;
}

const aiChunkSubscribers = new Map<string, (event: AiMessageChunkEvent) => void>();

/** 订阅指定 streamId 的 AI 流式增量；返回取消订阅函数。 */
export function subscribeAiChunks(
  streamId: string,
  handler: (event: AiMessageChunkEvent) => void,
): () => void {
  aiChunkSubscribers.set(streamId, handler);
  return () => {
    aiChunkSubscribers.delete(streamId);
  };
}

export const rpc = Electroview.defineRPC<AppRPC>({
  handlers: {
    requests: {},
    messages: {
      pushRows: ({ rows }) => {
        _rows?.(rows);
      },
      authStateChanged: ({ state }) => {
        applyAuthState(state);
      },
      aiMessageChunk: (event) => {
        aiChunkSubscribers.get(event.streamId)?.(event);
      },
    },
  },
});

export const view = new Electroview({ rpc });
