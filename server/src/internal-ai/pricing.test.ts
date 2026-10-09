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
