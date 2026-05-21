import { Electroview } from "electrobun/view";
import type {
  AiMessageChunkEvent,
  AiProgressEvent,
  AiRunCancelledEvent,
  AppRPC,
  WorkflowSuspendedEvent,
} from "../../shared/rpc.types";
import { applyAuthState } from "./auth.svelte";

let _rows: ((rows: { id: string; name: string; value: string }[]) => void) | null = null;

export function onPushRows(cb: (rows: { id: string; name: string; value: string }[]) => void) {
  _rows = cb;
}

const aiChunkSubscribers = new Map<string, (event: AiMessageChunkEvent) => void>();
const aiProgressSubscribers = new Map<string, (event: AiProgressEvent) => void>();
const aiSuspendedSubscribers = new Map<string, (event: WorkflowSuspendedEvent) => void>();
const aiRunCancelledSubscribers = new Map<string, (event: AiRunCancelledEvent) => void>();

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

/** 订阅指定 runId 的 workflow 暂停事件（ambiguous / await-write-confirm）。 */
export function subscribeAiSuspended(
  runId: string,
  handler: (event: WorkflowSuspendedEvent) => void,
): () => void {
  aiSuspendedSubscribers.set(runId, handler);
  return () => {
    aiSuspendedSubscribers.delete(runId);
  };
}

export function subscribeAiRunCancelled(
  runId: string,
  handler: (event: AiRunCancelledEvent) => void,
): () => void {
  aiRunCancelledSubscribers.set(runId, handler);
  return () => {
    aiRunCancelledSubscribers.delete(runId);
  };
}

export const rpc = Electroview.defineRPC<AppRPC>({
  // Electrobun 默认 1000ms，但创建工作簿/字段会触发多次远端
  // execTemplate (HTTPS 往返)，单次耗时常 > 1s。Infinity 关掉客户端层
  // 超时，错误兜底由 services 层的 withResult/Result 协议负责。
  maxRequestTime: Infinity,
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
      aiSuspended: (event) => {
        aiSuspendedSubscribers.get(event.runId)?.(event);
      },
      aiRunCancelled: (event) => {
        aiRunCancelledSubscribers.get(event.runId)?.(event);
      },
    },
  },
});

export const view = new Electroview({ rpc });
