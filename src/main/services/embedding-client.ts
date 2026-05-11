import type { EmbeddingSettings } from "./settings";
import { ServiceError } from "./errors";

export type EmbeddingFetch = typeof fetch;

export async function generateEmbeddingVector(
  settings: EmbeddingSettings,
  text: string,
  fetchImpl: EmbeddingFetch = fetch,
): Promise<number[]> {
  const input = text.trim();
  if (!input) throw new ServiceError("VALIDATION_ERROR", "embedding 文本不能为空");
  if (!settings.secretConfigured || !settings.apiKey?.trim()) {
    throw new ServiceError("VALIDATION_ERROR", "embedding API Key 未配置");
  }
  if (settings.apiFormat === "anthropic") {
    throw new ServiceError("VALIDATION_ERROR", "当前仅支持 OpenAI 兼容 embedding API");
  }

  const endpoint = embeddingEndpoint(settings);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input,
        model: settings.model,
        dimensions: settings.dimensions,
        encoding_format: "float",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new ServiceError("INTERNAL_ERROR", `embedding 请求失败：HTTP ${response.status}`);
    }

    const payload = await response.json();
    const vector = parseEmbeddingVector(payload);
    if (vector.length !== settings.dimensions) {
      throw new ServiceError(
        "INTERNAL_ERROR",
        `embedding 维度不匹配：期望 ${settings.dimensions}，实际 ${vector.length}`,
      );
    }
    return vector;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ServiceError("INTERNAL_ERROR", "embedding 请求超时");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function embeddingEndpoint(settings: EmbeddingSettings): string {
  const baseUrl = settings.baseUrl?.trim()
    || (settings.provider === "openai" ? "https://api.openai.com/v1" : undefined);
  if (!baseUrl) {
    throw new ServiceError("VALIDATION_ERROR", "非 OpenAI 默认 provider 需要配置 embedding baseUrl");
  }
  return new URL("embeddings", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function parseEmbeddingVector(payload: unknown): number[] {
  if (!payload || typeof payload !== "object") {
    throw new ServiceError("INTERNAL_ERROR", "embedding 响应格式无效");
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data) || !data.length) {
    throw new ServiceError("INTERNAL_ERROR", "embedding 响应缺少 data");
  }
  const first = data[0];
  const embedding = first && typeof first === "object"
    ? (first as { embedding?: unknown }).embedding
    : undefined;
  if (!Array.isArray(embedding) || !embedding.every((item) => typeof item === "number" && Number.isFinite(item))) {
    throw new ServiceError("INTERNAL_ERROR", "embedding 响应缺少有效向量");
  }
  return embedding;
}
