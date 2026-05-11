import { describe, expect, test } from "bun:test";
import { generateEmbeddingVector } from "./embedding-client";
import type { EmbeddingSettings } from "./settings";

const settings: EmbeddingSettings = {
  provider: "openai",
  model: "text-embedding-3-small",
  dimensions: 3,
  version: "v1",
  apiFormat: "openai-compatible",
  apiKey: "sk-test",
  secretConfigured: true,
};

describe("embedding client", () => {
  test("调用 OpenAI-compatible embeddings endpoint 并解析向量", async () => {
    const calls: Array<{ url: string; body: unknown; auth: string | null }> = [];
    const vector = await generateEmbeddingVector(settings, " 合同解除案例 ", async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    });

    expect(vector).toEqual([0.1, 0.2, 0.3]);
    expect(calls).toEqual([{
      url: "https://api.openai.com/v1/embeddings",
      body: {
        input: "合同解除案例",
        model: "text-embedding-3-small",
        dimensions: 3,
        encoding_format: "float",
      },
      auth: "Bearer sk-test",
    }]);
  });

  test("custom provider 使用配置的 baseUrl", async () => {
    const vector = await generateEmbeddingVector({
      ...settings,
      provider: "custom",
      baseUrl: "https://embedding.example/v1",
    }, "query", async (url) => {
      expect(String(url)).toBe("https://embedding.example/v1/embeddings");
      return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    });

    expect(vector).toEqual([0.1, 0.2, 0.3]);
  });

  test("维度不匹配时失败，避免污染向量索引", async () => {
    await expect(generateEmbeddingVector(settings, "query", async () =>
      Response.json({ data: [{ embedding: [0.1, 0.2] }] })
    )).rejects.toThrow("embedding 维度不匹配");
  });

  test("未配置密钥时不发起请求", async () => {
    await expect(generateEmbeddingVector({
      ...settings,
      apiKey: undefined,
      secretConfigured: false,
    }, "query", async () => {
      throw new Error("不应调用 fetch");
    })).rejects.toThrow("embedding API Key 未配置");
  });
});
