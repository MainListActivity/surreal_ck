import { describe, expect, test } from "bun:test";
import { createOpenAiCompatibleEmbeddingProvider } from "./embedding-provider";

const profile = {
  provider: "openai",
  model: "text-embedding-3-small",
  dimensions: 3,
  version: "v1",
};

describe("createOpenAiCompatibleEmbeddingProvider", () => {
  test("按 profile 调 /embeddings：带服务端 key、model 与文本，返回向量", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const provider = createOpenAiCompatibleEmbeddingProvider({
      apiKey: "sk-test",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init: init! });
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 });
      },
    });

    const vector = await provider.embed({ text: "标题\n摘要", profile });

    expect(vector).toEqual([0.1, 0.2, 0.3]);
    expect(requests[0].url).toBe("https://api.openai.com/v1/embeddings");
    expect(requests[0].init.headers).toMatchObject({ authorization: "Bearer sk-test" });
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      model: "text-embedding-3-small",
      input: "标题\n摘要",
    });
  });

  test("profile.base_url 覆盖默认 endpoint", async () => {
    let calledUrl = "";
    const provider = createOpenAiCompatibleEmbeddingProvider({
      apiKey: "sk-test",
      fetchImpl: async (url) => {
        calledUrl = String(url);
        return new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), { status: 200 });
      },
    });

    await provider.embed({ text: "t", profile: { ...profile, base_url: "https://llm.internal/v1" } });
    expect(calledUrl).toBe("https://llm.internal/v1/embeddings");
  });

  test("非 2xx 响应 → 抛错且不重试", async () => {
    let calls = 0;
    const provider = createOpenAiCompatibleEmbeddingProvider({
      apiKey: "sk-test",
      fetchImpl: async () => {
        calls += 1;
        return new Response("rate limited", { status: 429 });
      },
    });

    await expect(provider.embed({ text: "t", profile })).rejects.toThrow("429");
    expect(calls).toBe(1);
  });

  test("不支持的 api_format → 明确报错", async () => {
    const provider = createOpenAiCompatibleEmbeddingProvider({
      apiKey: "sk-test",
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });

    await expect(
      provider.embed({ text: "t", profile: { ...profile, api_format: "anthropic" } }),
    ).rejects.toThrow("api_format");
  });
});
