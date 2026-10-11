import { ModelRouterLanguageModel } from "@mastra/core/llm";
import type { AiSettings } from "../../ai/mastra/agents/model-config";
import { buildModelConfig } from "../../ai/mastra/agents/model-config";
import type { InternalAiGate } from "./gate";
import { internalScope } from "./context";
import { normalizeUsage, type Usage } from "./pricing";
type Options = Parameters<ModelRouterLanguageModel["doStream"]>[0];
type Result = Awaited<ReturnType<ModelRouterLanguageModel["doStream"]>>;
/**
 * internal scope 下剥离 Mastra 多步回传的 reasoning part：openai-compatible 会把它上行成
 * reasoning_content，逐步重发全量推理既放大计量 input、又依赖上游对该入站字段的支持；
 * 剥离后请求形状与已验证的单步路径一致。其余未知 part 仍由门卫 fail-closed。
 */
function withoutReasoningEcho(options: Options): Options {
  return {
    ...options,
    prompt: options.prompt.map(message =>
      message.role === "assistant"
        ? { ...message, content: message.content.filter(part => part.type !== "reasoning") }
        : message),
  };
}
/** V2 provider调用seam：每模型step仅计一次finish，不再累计Mastra聚合usage。 */
export class InternalBudgetModel extends ModelRouterLanguageModel {
  constructor(private readonly settings: AiSettings, private readonly stage: string, private readonly gate?: InternalAiGate) { super(buildModelConfig(settings)); }
  override async doGenerate(options: Options): Promise<Result> { return this.invoke(options, false); }
  override async doStream(options: Options): Promise<Result> { return this.invoke(options, true); }
  private async invoke(options: Options, streaming: boolean): Promise<Result> {
    const scope = internalScope();
    const config = buildModelConfig(this.settings);
    if (scope && !this.gate) throw new Error("internal-ai-gate-unavailable");
    const endpoint = this.settings.baseUrl ?? "";
    const effective = scope ? withoutReasoningEcho(options) : options;
    // 先拒绝已知不能计费的格式：未发送，不占provider attempt名额。
    if (scope && (effective.tools?.some(t => t.type !== "function") || effective.prompt.some(m => m.role !== "system" && m.content.some(c => c.type !== "text" && c.type !== "tool-call" && c.type !== "tool-result" || (c.type === "tool-result" && !["text", "json", "error-text", "error-json"].includes(c.output.type)))) || (effective.providerOptions && Object.keys(effective.providerOptions).some(k => k !== "openai" || Object.keys(effective.providerOptions!.openai ?? {}).some(key => key !== "stream"))))) {
      throw new Error("internal-ai-input-format-unavailable");
    }
    const ticket = await this.gate?.begin(this.stage, config.providerId, config.modelId, endpoint);
    if (!ticket) return streaming ? super.doStream(effective) : super.doGenerate(effective);
    const capped = { ...effective, maxOutputTokens: Math.min(effective.maxOutputTokens ?? ticket.tariff.maxOutput, ticket.tariff.maxOutput) };
    try {
      const result = streaming ? await super.doStream(capped) : await super.doGenerate(capped);
      const reader = result.stream.getReader();
      let usage: Usage | null = null;
      let model: string | null = null;
      let request: string | null = null;
      let failed = false;
      let ended = false;
      const finish = async (error: boolean) => {
        if (ended) return;
        ended = true;
        await this.gate!.finish(ticket, usage, model, request, failed || error);
      };
      return { ...result, stream: new ReadableStream({
        async pull(controller) {
          try {
            const item = await reader.read();
            if (item.done) { await finish(false); controller.close(); return; }
            const part = item.value;
            if (part.type === "response-metadata") { model = part.modelId ?? null; request = part.id ?? null; }
            if (part.type === "finish") usage = normalizeUsage(part.usage);
            if (part.type === "error") failed = true;
            controller.enqueue(part);
          } catch { await finish(true); controller.error(new Error("internal-ai-provider-stream-failed")); }
        },
        async cancel() { try { await reader.cancel(); } finally { await finish(true); } },
      }) };
    } catch {
      await this.gate!.finish(ticket, null, null, null, true);
      throw new Error("internal-ai-provider-failed");
    }
  }
}
export function buildAgentModel(settings: AiSettings, stage: string): ModelRouterLanguageModel { return new InternalBudgetModel(settings, stage, settings.internalAiGate); }
