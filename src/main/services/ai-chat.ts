import { Agent } from "@mastra/core/agent";
import { ModelRouterLanguageModel } from "@mastra/core/llm";
import type { AiChatMessage } from "../../shared/ai-context";
import type {
  AiMessageChunkEvent,
  SendAiMessageRequest,
  SendAiMessageResponse,
} from "../../shared/rpc.types";
import { initMastraForCurrentUser } from "../ai/index";
import { assertAuthenticated } from "./context";
import { ServiceError } from "./errors";
import { getAiSettings } from "./settings";

const WORKSPACE_AGENT_KEY = "workspaceAgent";

export type AiChunkSender = (event: AiMessageChunkEvent) => void;

export async function sendAiMessage(
  req: SendAiMessageRequest,
  pushChunk?: AiChunkSender,
): Promise<SendAiMessageResponse> {
  assertAuthenticated();
  const settings = await getAiSettings();
  if (!settings.secretConfigured || !settings.apiKey?.trim()) {
    throw new ServiceError("VALIDATION_ERROR", "请先在设置中配置 AI API Key");
  }

  const mastra = initMastraForCurrentUser();
  const agent = new Agent({
    id: WORKSPACE_AGENT_KEY,
    name: "Workspace Agent",
    instructions: [
      "你是 Surreal CK 的工作区 AI 助手。",
      "始终使用简体中文回答。",
      "你会收到当前路由、工作簿、数据表和选中记录上下文。只基于用户提供的上下文和可用工具作答。",
      "当前阶段不能直接修改数据；涉及导航、仪表盘创建或记录更新时，先说明建议和需要用户确认的下一步。",
    ],
    model: new ModelRouterLanguageModel(buildModelConfig(settings)),
  });

  if (!mastra.listAgents()[WORKSPACE_AGENT_KEY]) {
    mastra.addAgent(agent, WORKSPACE_AGENT_KEY);
  }

  const { streamId } = req;
  const stream = await agent.stream(buildPrompt(req.message), { maxSteps: 4 });

  let aggregated = "";
  try {
    for await (const delta of stream.textStream) {
      if (!delta) continue;
      aggregated += delta;
      pushChunk?.({ streamId, type: "delta", text: delta });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pushChunk?.({ streamId, type: "error", message });
    throw new ServiceError("INTERNAL_ERROR", message);
  }

  const finalText = aggregated || (await stream.text) || "我没有生成有效回复。";
  pushChunk?.({ streamId, type: "done" });

  return {
    message: {
      id: crypto.randomUUID(),
      role: "assistant",
      content: finalText,
      createdAt: new Date().toISOString(),
      context: req.message.context,
    },
    toolCalls: [],
  };
}

function buildModelConfig(settings: Awaited<ReturnType<typeof getAiSettings>>) {
  const { providerId, modelId } = splitModel(settings.provider, settings.model);
  return {
    providerId,
    modelId,
    ...(settings.baseUrl ? { url: settings.baseUrl } : {}),
    apiKey: settings.apiKey,
  };
}

function splitModel(provider: string, model: string): { providerId: string; modelId: string } {
  const trimmed = model.trim();
  if (trimmed.includes("/")) {
    const [providerId, ...modelParts] = trimmed.split("/");
    return { providerId, modelId: modelParts.join("/") };
  }
  return { providerId: provider, modelId: trimmed };
}

function buildPrompt(message: AiChatMessage): string {
  return [
    `用户问题：${message.content}`,
    "",
    "当前上下文快照：",
    JSON.stringify(message.context, null, 2),
  ].join("\n");
}
