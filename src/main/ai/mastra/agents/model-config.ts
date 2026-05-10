import type { AiSettings } from "../../../services/settings";

export function buildModelConfig(settings: AiSettings) {
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
