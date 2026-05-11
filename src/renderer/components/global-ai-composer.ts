import type { SendAiMessageRequest } from "../../shared/rpc.types";

export type AiComposerMode = "chat" | "resource-search";

export type ComposerDraftState = {
  prompt: string;
  mode: AiComposerMode;
};

export function selectComposerMode(state: ComposerDraftState, mode: AiComposerMode): ComposerDraftState {
  return { ...state, mode };
}

export function composerModeView(mode: AiComposerMode): { icon: "send" | "search"; label: string } {
  if (mode === "resource-search") return { icon: "search", label: "搜索资源" };
  return { icon: "send", label: "发送" };
}

export function buildComposerSendOptions(mode: AiComposerMode): Pick<SendAiMessageRequest, "composerMode"> {
  return mode === "resource-search" ? { composerMode: "resource-search" } : {};
}
