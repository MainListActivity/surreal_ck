import type { AiChatMessage } from "../../shared/ai-context";
import type { AiMessageChunkEvent, AiToolCallRecord, ToolNavigationIntent } from "../../shared/rpc.types";

export type PendingIntent = {
  messageId: string;
  intent: ToolNavigationIntent;
  dismissed: boolean;
};

export type AiStreamState = {
  messages: AiChatMessage[];
  pendingIntents: PendingIntent[];
  sending: boolean;
  sendError: string | null;
  streamedText: string;
};

export function extractNavigationIntent(toolCalls: AiToolCallRecord[]): ToolNavigationIntent | null {
  const navTools = ["navigateTool", "searchWorkbookTool", "searchDashboardTool", "searchRecordTool"];
  for (const tc of toolCalls) {
    if (!navTools.includes(tc.toolName)) continue;
    const result = tc.result as { intent?: ToolNavigationIntent } | undefined;
    if (result?.intent) return result.intent;
  }
  return null;
}

export function replaceOrAppendAssistantMessage(
  messages: AiChatMessage[],
  placeholderId: string,
  message: AiChatMessage,
): AiChatMessage[] {
  const found = messages.some((m) => m.id === placeholderId);
  if (!found) return [...messages, message];
  return messages.map((m) => (m.id === placeholderId ? { ...m, ...message } : m));
}

export function applyAiChunkToMessages(
  state: AiStreamState,
  placeholderId: string,
  event: AiMessageChunkEvent,
): AiStreamState {
  if (event.type === "delta") {
    return {
      ...state,
      streamedText: state.streamedText + event.text,
      messages: state.messages.map((m) =>
        m.id === placeholderId ? { ...m, content: m.content + event.text } : m,
      ),
    };
  }

  if (event.type === "error") {
    const hasVisibleText = state.streamedText.trim().length > 0;
    return {
      ...state,
      sending: false,
      sendError: event.message || "AI 回复失败，请稍后重试。",
      messages: hasVisibleText ? state.messages : state.messages.filter((m) => m.id !== placeholderId),
    };
  }

  const finalMessageId = event.message.id;
  const intent = extractNavigationIntent(event.toolCalls ?? []);
  return {
    ...state,
    sending: false,
    messages: replaceOrAppendAssistantMessage(state.messages, placeholderId, event.message),
    pendingIntents: intent
      ? [...state.pendingIntents, { messageId: finalMessageId, intent, dismissed: false }]
      : state.pendingIntents,
  };
}
