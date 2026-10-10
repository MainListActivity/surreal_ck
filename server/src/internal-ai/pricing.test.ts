import { expect, test } from "bun:test";
import { actualCost, endpointHost, normalizeUsage, tariffFor, TARIFFS, worstCost } from "./pricing";
test("integer cash, cache subset and missing usage preserve unknown", () => {
  const t = TARIFFS[0]!;
  expect(worstCost(t)).toBe(29030400);
  expect(actualCost(t, { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 200, reasoningTokens: 0 }, t.model)).toBe(195000);
  expect(actualCost(t, normalizeUsage({ inputTokens: 1000, outputTokens: 100 }), t.model)).toBeNull();
  expect(normalizeUsage({}).inputTokens).toBeNull();
  expect(actualCost(t, normalizeUsage({}), t.model)).toBeNull();
  expect(actualCost(t, normalizeUsage({ inputTokens: 10, outputTokens: 10, cachedInputTokens: 11 }), t.model)).toBeNull();
  expect(actualCost(t, normalizeUsage({ inputTokens: 10, outputTokens: 10, reasoningTokens: 1 }), t.model)).toBeNull();
  expect(actualCost(t, normalizeUsage({ inputTokens: 10, outputTokens: 10 }), "new-version")).toBeNull();
});
test("fixed versions and exact vendor API only; metadata strips credentials", () => {
  expect(tariffFor("openai", "gpt-4o-mini", "https://api.openai.com/v1")).toBeUndefined();
  expect(tariffFor("openai", TARIFFS[0]!.model, "https://api.openai.com/other")).toBeUndefined();
  expect(tariffFor("openai", TARIFFS[0]!.model, "https://key:secret@api.openai.com/v1?key=secret")).toBeUndefined();
  expect(endpointHost("https://key:secret@example.com?key=secret")).toBeNull();
});
test("SenseNova token-plan zero-rate certificate covers only the fixed model on the exact v1 endpoint", () => {
  const t = TARIFFS.find(t => t.model === "sensenova-6.8-flash-lite")!;
  // 官方 List Models（platform.sensenova.cn/docs）核定：context_length 262144、max_output_length 65536、pricing 全 0。
  expect(t).toMatchObject({ provider: "openai", host: "token.sensenova.cn", maxInput: 262144, maxOutput: 65536, input: 0, cached: 0, output: 0 });
  expect(worstCost(t)).toBe(0);
  expect(tariffFor("openai", t.model, "https://token.sensenova.cn/v1")).toBe(t);
  expect(tariffFor("openai", t.model, "https://token.sensenova.cn/v1/chat/completions")).toBeUndefined();
  expect(tariffFor("openai", "sensenova-6.8-flash", "https://token.sensenova.com/v1")).toBeUndefined();
  expect(tariffFor("sensenova", t.model, "https://token.sensenova.cn/v1")).toBeUndefined();
  expect(actualCost(t, { inputTokens: 2000, outputTokens: 500, cachedInputTokens: null, reasoningTokens: null }, t.model)).toBe(0);
  expect(actualCost(t, { inputTokens: 262145, outputTokens: 1, cachedInputTokens: null, reasoningTokens: null }, t.model)).toBeNull();
  expect(actualCost(t, { inputTokens: 10, outputTokens: 10, cachedInputTokens: null, reasoningTokens: 5 }, t.model)).toBeNull();
});
