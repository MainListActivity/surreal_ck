/** 金额单位：nanoUSD（1 USD = 10^9），所有运算为安全整数。 */
export type Usage = { inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; reasoningTokens: number | null };
export type Tariff = { revision: string; provider: string; model: string; host: string; source: string; checkedAt: string; maxInput: number; maxOutput: number; input: number; cached: number; output: number };
// 仅接受固定版本及直连，不把 OpenAI-compatible 协议视为供应商身份。
export const TARIFFS: readonly Tariff[] = [
  { revision: "openai-mini-2026-10-09", provider: "openai", model: "gpt-4o-mini-2024-07-18", host: "api.openai.com", source: "https://developers.openai.com/api/docs/models/gpt-4o-mini", checkedAt: "2026-10-09", maxInput: 128000, maxOutput: 16384, input: 150, cached: 75, output: 600 },
  { revision: "jev-2026-10-09", provider: "typesafe", model: "jev-1.13.0", host: "api.typesafe.ai", source: "https://docs.typesafe.ai/models", checkedAt: "2026-10-09", maxInput: 64000, maxOutput: 0, input: 42, cached: 42, output: 0 },
  // SenseNova Token Plan 公测零费率证书：官方 List Models（platform.sensenova.cn/docs）明示 context_length 262144、
  // max_output_length 65536、pricing 全 0；官方 token-plan 页（www.sensenova.cn/token-plan）明示公测期完全免费。
  // provider=openai 是 SDK providerId 协议身份（OpenAI-compatible 装配所需），供应商事实由 host/model/revision/source 承载。
  { revision: "sensenova-token-plan-2026-10-10", provider: "openai", model: "sensenova-6.8-flash-lite", host: "token.sensenova.cn", source: "https://platform.sensenova.cn/docs", checkedAt: "2026-10-10", maxInput: 262144, maxOutput: 65536, input: 0, cached: 0, output: 0 },
];
export function endpointHost(url: string | undefined): string | null {
  try { const u = new URL(url ?? ""); return u.protocol === "https:" && !u.username && !u.password ? u.hostname : null; } catch { return null; }
}
export function tariffFor(provider: string, model: string, endpoint: string): Tariff | undefined {
  const u = new URL(endpoint);
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.port) return undefined;
  // 固定API路径，不能把同host的代理/批处理/其它收费服务套用此价。
  if (!(provider === "openai" && u.pathname.replace(/\/$/, "") === "/v1") && !(provider === "typesafe" && u.pathname === "/v1/systemone")) return undefined;
  return TARIFFS.find(t => t.provider === provider && t.model === model && t.host === u.hostname);
}
export function worstCost(t: Tariff): number { return t.maxInput * t.input + t.maxOutput * t.output; }
/**
 * 按端点与模型查**已核定价目证书**：provider 不由调用方给，而是逐本证书用自己的 provider 复核
 * 固定 API 路径，因此不可能把 OpenAI 的协议/证书价套到 token.sensenova.cn 或别的模型上。
 * 找不到即 unsupported——不编造每 token 现金价，也不把积分当 USD。
 */
export function certificateFor(endpoint: string, model: string): Tariff | undefined {
  let host: string;
  try { host = new URL(endpoint).hostname; } catch { return undefined; }
  for (const tariff of TARIFFS) {
    if (tariff.model !== model || tariff.host !== host) continue;
    if (tariffFor(tariff.provider, model, endpoint)) return tariff;
  }
  return undefined;
}
export function normalizeUsage(raw: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningTokens?: number }): Usage {
  const token = (n: number | undefined) => Number.isSafeInteger(n) && n! >= 0 ? n! : null;
  return { inputTokens: token(raw.inputTokens), outputTokens: token(raw.outputTokens), cachedInputTokens: token(raw.cachedInputTokens), reasoningTokens: token(raw.reasoningTokens) };
}
export function actualCost(t: Tariff, usage: Usage, model: string | null): number | null {
  const { inputTokens: i, outputTokens: o, cachedInputTokens: c, reasoningTokens: r } = usage;
  if (model !== t.model || i === null || o === null || i > t.maxInput || (t.output > 0 && o > t.maxOutput)) return null;
  // 当前证书仅非reasoning文本模型；不单独加reasoning，避免重复收费。
  if (r !== null && r !== 0) return null;
  if (c !== null && c > i) return null;
  // 独立cache费率缺usage时无法核定实际成本，保留最坏预留。
  if (c === null && t.cached !== t.input) return null;
  const cost = (i - (c ?? 0)) * t.input + (c ?? 0) * t.cached + o * t.output;
  return Number.isSafeInteger(cost) && cost <= worstCost(t) ? cost : null;
}
