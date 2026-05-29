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

export const rpc = {
  async request(): Promise<never> {
    throw new Error("legacy desktop RPC has retired");
  },
  send(event: keyof AppRPC["messages"], payload: unknown): void {
    if (event === "pushRows") {
      _rows?.((payload as { rows: { id: string; name: string; value: string }[] }).rows);
    } else if (event === "authStateChanged") {
      applyAuthState((payload as { state: Parameters<typeof applyAuthState>[0] }).state);
    } else if (event === "aiMessageChunk") {
      const next = payload as AiMessageChunkEvent;
      aiChunkSubscribers.get(next.streamId)?.(next);
    } else if (event === "aiProgress") {
      const next = payload as AiProgressEvent;
      aiProgressSubscribers.get(next.runId)?.(next);
    } else if (event === "aiSuspended") {
      const next = payload as WorkflowSuspendedEvent;
      aiSuspendedSubscribers.get(next.runId)?.(next);
    } else if (event === "aiRunCancelled") {
      const next = payload as AiRunCancelledEvent;
      aiRunCancelledSubscribers.get(next.runId)?.(next);
    }
  },
};

export const view = { rpc };
