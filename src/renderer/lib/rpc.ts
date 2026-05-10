import { Electroview } from "electrobun/view";
import type { AiMessageChunkEvent, AiProgressEvent, AppRPC } from "../../shared/rpc.types";
import { applyAuthState } from "./auth.svelte";

let _rows: ((rows: { id: string; name: string; value: string }[]) => void) | null = null;

export function onPushRows(cb: (rows: { id: string; name: string; value: string }[]) => void) {
  _rows = cb;
}

const aiChunkSubscribers = new Map<string, (event: AiMessageChunkEvent) => void>();
const aiProgressSubscribers = new Map<string, (event: AiProgressEvent) => void>();

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

/** 订阅指定 runId 的 ai.progressStream 事件（tool-call / routing / agent-step）。 */
export function subscribeAiProgress(
  runId: string,
  handler: (event: AiProgressEvent) => void,
): () => void {
  aiProgressSubscribers.set(runId, handler);
  return () => {
    aiProgressSubscribers.delete(runId);
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
      aiProgress: (event) => {
        aiProgressSubscribers.get(event.runId)?.(event);
      },
      aiSuspended: () => {},
    },
  },
});

export const view = new Electroview({ rpc });
