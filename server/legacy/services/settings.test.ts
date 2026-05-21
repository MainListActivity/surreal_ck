import { describe, expect, test } from "bun:test";
import { EMBEDDING_SETTINGS_KEY, AI_SETTINGS_KEY, toAiSettingsDTO, toEmbeddingSettingsDTO } from "./settings";

describe("toAiSettingsDTO", () => {
  test("返回给 renderer 的 AI 设置不包含 API Key 明文", () => {
    const dto = toAiSettingsDTO({
      provider: "openai",
      model: "gpt-5.4",
      apiFormat: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-live-secret",
      secretConfigured: true,
    });

    expect(dto).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      apiFormat: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      secretConfigured: true,
    });
    expect("apiKey" in dto).toBe(false);
  });
});

describe("embedding settings", () => {
  test("embedding 配置独立于聊天模型设置且不向 renderer 暴露 API Key", () => {
    const dto = toEmbeddingSettingsDTO({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      version: "2026-05-11",
      apiFormat: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-embedding-secret",
      secretConfigured: true,
    });

    expect(EMBEDDING_SETTINGS_KEY).not.toBe(AI_SETTINGS_KEY);
    expect(dto).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      version: "2026-05-11",
      apiFormat: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      secretConfigured: true,
    });
    expect("apiKey" in dto).toBe(false);
  });
});
