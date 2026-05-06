import { describe, expect, test } from "bun:test";
import { toAiSettingsDTO } from "./settings";

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
