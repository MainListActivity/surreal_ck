import type { Agent } from "@mastra/core/agent";
import type { AiChatMessage } from "../../shared/ai-context";
import { serializeContextForAi } from "../../shared/ai-context";
import type {
  AiMessageChunkEvent,
  AiToolCallRecord,
  SendAiMessageRequest,
  SendAiMessageResponse,
} from "../../shared/rpc.types";
import { createWorkspaceAgent, WORKSPACE_AGENT_ID } from "../ai/mastra/agents/workspace-agent";
import { initMastraForCurrentUser } from "../ai/index";
import { assertAuthenticated } from "./context";
import { getAiSettings } from "./settings";

export type AiChunkSender = (event: AiMessageChunkEvent) => void;

export function buildDegradedResponse(
  req: Pick<SendAiMessageRequest, "streamId" | "message">,
  content: string,
): SendAiMessageResponse {
  const message: SendAiMessageResponse["message"] = {
    id: crypto.randomUUID(),
    role: "assistant",
    content,
    createdAt: new Date().toISOString(),
    context: req.message.context,
  };
  return { message, toolCalls: [] };
}

export async function sendAiMessage(
  req: SendAiMessageRequest,
  pushChunk?: AiChunkSender,
): Promise<SendAiMessageResponse> {
  assertAuthenticated();
  const settings = await getAiSettings();
  if (!settings.secretConfigured || !settings.apiKey?.trim()) {
    const res = buildDegradedResponse(req, "请先在设置中配置 AI API Key，才能使用 AI 功能。");
    pushChunk?.({ streamId: req.streamId, type: "done", message: res.message });
    return res;
  }

  const mastra = initMastraForCurrentUser();
  if (!mastra.listAgents()[WORKSPACE_AGENT_ID]) {
    mastra.addAgent(createWorkspaceAgent(settings), WORKSPACE_AGENT_ID);
  }
  const agent = mastra.getAgent(WORKSPACE_AGENT_ID);

  void streamAiMessage(req, agent, pushChunk);

  return {
    message: {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      context: req.message.context,
    },
    toolCalls: [],
  };
}

async function streamAiMessage(
  req: SendAiMessageRequest,
  agent: Agent,
  pushChunk?: AiChunkSender,
): Promise<void> {
  const { streamId } = req;
  let aggregated = "";
  const collectedToolCalls: AiToolCallRecord[] = [];

  try {
    const historyMessages = buildHistoryMessages(req.history ?? []);
    const currentMessage = { role: "user" as const, content: buildPrompt(req.message) };
    const allMessages = [...historyMessages, currentMessage];

    const stream = await agent.stream(allMessages, {
      maxSteps: 4,
      providerOptions: { openai: { stream: true } },
      onStepFinish: ({ toolCalls, toolResults }) => {
        if (!toolResults?.length) return;
        for (const tr of toolResults as Array<{ toolCallId: string; toolName: string; args?: unknown; result: unknown }>) {
          const call = (toolCalls as Array<{ toolCallId: string; args?: unknown }>)
            ?.find((tc) => tc.toolCallId === tr.toolCallId);
          collectedToolCalls.push({
            toolName: tr.toolName,
            args: call?.args ?? tr.args,
            result: tr.result,
          });
        }
      },
    });

    for await (const delta of stream.textStream) {
      if (!delta) continue;
      aggregated += delta;
      pushChunk?.({ streamId, type: "delta", text: delta });
    }

    const finalText = aggregated || (await stream.text) || "我没有生成有效回复。";
    pushChunk?.({
      streamId,
      type: "done",
      toolCalls: collectedToolCalls,
      message: {
        id: crypto.randomUUID(),
        role: "assistant",
        content: finalText,
        createdAt: new Date().toISOString(),
        context: req.message.context,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pushChunk?.({ streamId, type: "error", message });
  }
}

type CoreMessage = { role: "user" | "assistant"; content: string };

export function buildHistoryMessages(history: AiChatMessage[]): CoreMessage[] {
  return history.map((msg) => ({
    role: msg.role,
    content: msg.role === "user" ? buildPrompt(msg) : msg.content,
  }));
}

function buildPrompt(message: AiChatMessage): string {
  return [
    `用户问题：${message.content}`,
    "",
    "当前上下文快照：",
    JSON.stringify(serializeContextForAi(message.context), null, 2),
  ].join("\n");
}
