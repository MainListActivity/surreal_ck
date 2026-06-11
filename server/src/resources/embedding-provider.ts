/**
 * 生产 embedding 生成器：openai-compatible /embeddings 调用。
 *
 * key 只存在于服务端环境变量（EMBEDDING_API_KEY），与 chat 模型设置分离；
 * provider / model / dimensions / base_url 来自 workspace 的 embedding profile。
 * V1 只支持 openai-compatible；失败不重试——保存动作整体失败，由用户再次点击保存。
 */
import type { EmbeddingProfile, EmbeddingProvider } from "./research-save";
import { env } from "../env";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type OpenAiCompatibleEmbeddingOptions = {
  apiKey: string;
  fetchImpl?: FetchLike;
};

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** env.EMBEDDING_API_KEY 存在时的默认生成器；缺席返回 undefined（检索退化为关键词 + 状态推断）。 */
export function createDefaultEmbeddingProvider(): EmbeddingProvider | undefined {
  if (!env.EMBEDDING_API_KEY) return undefined;
  return createOpenAiCompatibleEmbeddingProvider({ apiKey: env.EMBEDDING_API_KEY });
}

export function createOpenAiCompatibleEmbeddingProvider(
  options: OpenAiCompatibleEmbeddingOptions,
): EmbeddingProvider {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));

  return {
    async embed({ text, profile }: { text: string; profile: EmbeddingProfile }): Promise<number[]> {
      if (profile.api_format && profile.api_format !== "openai-compatible") {
        throw new Error(`embedding api_format ${profile.api_format} 尚未支持（V1 仅 openai-compatible）`);
      }

      const baseUrl = (profile.base_url ?? DEFAULT_BASE_URL).replace(/\/$/, "");
      const response = await fetchImpl(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({ model: profile.model, input: text }),
      });

      if (!response.ok) {
        throw new Error(`embedding provider 返回 ${response.status}`);
      }

      const payload = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
      const vector = payload.data?.[0]?.embedding;
      if (!Array.isArray(vector)) {
        throw new Error("embedding provider 响应缺少向量数据");
      }
      return vector;
    },
  };
}
