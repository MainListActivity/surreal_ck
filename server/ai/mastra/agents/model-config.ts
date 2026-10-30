import type { InternalAiGate } from "../../../src/internal-ai/gate";
export type AiSettings = {
  internalAiGate?: InternalAiGate;
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  [key: string]: unknown;
};

export function buildModelConfig(settings: AiSettings) {
  const { providerId, modelId } = splitModel(settings.provider, settings.model);
  return {
    providerId,
    modelId,
    ...(settings.baseUrl ? { url: settings.baseUrl } : {}),
    apiKey: settings.apiKey,
  };
}

/** 受控运行身份：请求路径（buildModelConfig）与远端窗口创建交叉核对共用同一 splitModel 规则。 */
export type RuntimeIdentity = { providerId: string; modelId: string; endpoint: string };
export function runtimeIdentity(settings: Pick<AiSettings, "provider" | "model" | "baseUrl">): RuntimeIdentity {
  const { providerId, modelId } = splitModel(settings.provider, settings.model);
  return { providerId, modelId, endpoint: settings.baseUrl ?? "" };
}

function splitModel(provider: string, model: string): { providerId: string; modelId: string } {
  const trimmed = model.trim();
  if (trimmed.includes("/")) {
    const [providerId, ...modelParts] = trimmed.split("/");
    return { providerId, modelId: modelParts.join("/") };
  }
  return { providerId: provider, modelId: trimmed };
}
