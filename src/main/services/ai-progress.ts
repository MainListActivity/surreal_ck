import type { AiProgressEvent } from "../../shared/rpc.types";

export type AiProgressSender = (event: AiProgressEvent) => void;

type StepFinishLike = {
  toolResults?: Array<{ toolCallId: string; toolName: string; result?: unknown; args?: unknown }>;
};

/**
 * 将一次 agent step 完成时的 toolResults 翻译为 ai.progressStream 事件。
 * V1 仅产出 "tool-call" 事件；"routing" / "agent-step" 由 issue 011/012 的 Router workflow 填充。
 */
export function buildToolCallProgressEvents(runId: string, step: StepFinishLike): AiProgressEvent[] {
  const results = step.toolResults ?? [];
  const events: AiProgressEvent[] = [];
  for (const tr of results) {
    if (!tr.toolName) continue;
    events.push({ kind: "tool-call", runId, toolId: tr.toolName });
  }
  return events;
}
