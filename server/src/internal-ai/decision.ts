import type { DecisionCaller } from "../../ai/decision/model";
import type { InternalAiGate } from "./gate";
import { normalizeUsage } from "./pricing";
/** HTTP client本身无重试；Jev失败和fallback会各自获得独立预留。 */
export function meteredDecision(caller: DecisionCaller, gate: InternalAiGate, configuredModel: string): DecisionCaller {
  return async input => {
    const ticket = await gate.begin("jev-classify", "typesafe", input.model ?? configuredModel, "https://api.typesafe.ai/v1/systemone");
    try {
      const result = await caller(input);
      await gate.finish(ticket, normalizeUsage(result.usage), result.model, null, false);
      return result;
    } catch (error) { await gate.finish(ticket, null, null, null, true); throw error; }
  };
}
