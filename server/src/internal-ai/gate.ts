import { internalScope, inInternalScope, type InternalScope } from "./context";
import { InternalAiStore } from "./store";
import { actualCost, tariffFor, worstCost, type Tariff, type Usage } from "./pricing";
import { assessWindowCost, routeMatches, windowAmount, windowTariff, type WindowRow } from "./window";
import type { RecordId } from "surrealdb";
export type AttemptTicket = { id: RecordId; tariff: Tariff; window?: WindowRow };
/** Interface：bind/inRun保持身份；begin/finish包住实际provider尝试。没有客户可设置的budget字段。 */
export class InternalAiGate {
  constructor(readonly store: InternalAiStore, private readonly assertCurrent?: (activity: string) => Promise<void>) {}
  async bind(subject: string, database: string, run: string, key?: string): Promise<InternalScope | undefined> {
    const bound = await this.store.binding(subject, database);
    // 撤销身份保持拒绝：标记撤销或曾有内部run（含binding被删）的新旧run/key一律拒绝，不降级非计量run。
    if (bound?.revoked) throw new Error("internal-ai-binding-revoked");
    if (!bound) {
      const previous = await this.store.runActivity(subject, database, run) ?? await this.store.identityActivity(subject, database);
      if (previous) throw new Error("internal-ai-binding-revoked");
      return undefined;
    }
    return this.store.scope(bound.activity, subject, database, run, key);
  }
  inRun<T>(scope: InternalScope | undefined, work: () => T): T { return scope ? inInternalScope(scope, work) : work(); }
  async begin(stage: string, provider: string, model: string, endpoint: string): Promise<AttemptTicket | undefined> {
    const scope = internalScope();
    if (!scope) return undefined;
    await this.assertCurrent?.(scope.activity);
    // 新窗口优先：旧固定供应商价目是 fail-closed 的，窗口必须用自己冻结的路由/价格依据；
    // 完全不匹配时绝不回退旧 tariffFor，避免把旧证书语义套到新路由上。
    const window = await this.store.boundWindow(scope.activity);
    if (window) {
      if (window.status !== "active") throw new Error("internal-ai-evidence-unavailable");
      if (Date.parse(window.evidence_expires_at) <= Date.now()) throw new Error("internal-ai-evidence-unavailable");
      if (window.attempts >= window.attempt_limit) throw new Error("internal-ai-budget-exhausted");
      if (!routeMatches(window, provider, model, endpoint)) throw new Error("internal-ai-route-drift");
      if (window.price_basis === "unknown") throw new Error("internal-ai-price-unassessed");
      let tariff: Tariff;
      let amount: number;
      try {
        // 预留/账本的 model 是**请求** model（group/work）；served model 只用于价目与成本核定。
        tariff = { ...windowTariff(window), model: window.requested_model };
        amount = windowAmount(window);
      } catch { throw new Error("internal-ai-price-or-bound-unavailable"); }
      const row = await this.store.reserve(scope, scope.stage ?? stage, tariff, amount, window);
      await this.store.sent(row.id);
      return { id: row.id, tariff, window };
    }
    let tariff: Tariff | undefined;
    try { tariff = tariffFor(provider, model, endpoint); } catch { /* unknown URL denies */ }
    if (!tariff) throw new Error("internal-ai-price-or-bound-unavailable");
    const row = await this.store.reserve(scope, scope.stage ?? stage, tariff, worstCost(tariff));
    // 持久sent标记先于传输；此后任意异常均保留预留。
    await this.store.sent(row.id);
    return { id: row.id, tariff };
  }
  async finish(ticket: AttemptTicket | undefined, usage: Usage | null, model: string | null, request: string | null, failed: boolean, failureClass?: string | null): Promise<void> {
    if (!ticket) return;
    if (!ticket.window) {
      await this.store.finish(ticket.id, { usage, actualModel: model, requestId: request, cost: usage ? actualCost(ticket.tariff, usage, model) : null, failed, usageRaw: usage ? rawUsage(usage) : null, failureClass: failed ? failureClass ?? "provider-failed" : null });
      return;
    }
    // 窗口路径：servedModel 漂移/缺 usage/非法 usage 一律 cost=null；只有真实免费证据才允许 0。
    // 传输失败不是路由漂移：没有响应 metadata 时按 provider-failed 记，仍保留预留与失败类别。
    const assessment = failed
      ? { cost: null, status: "provider-failed", routeDrift: false, amortized: ticket.window.amortized_nano_usd ?? null, marginal: ticket.window.marginal_nano_usd ?? null }
      : assessWindowCost(ticket.window, usage, model);
    await this.store.finish(ticket.id, {
      usage, actualModel: model, requestId: request,
      cost: failed ? null : assessment.cost,
      failed: failed || assessment.routeDrift,
      usageRaw: usage ? rawUsage(usage) : null,
      costStatus: assessment.status,
      amortized: assessment.amortized,
      marginal: assessment.marginal,
      failureClass: failed ? failureClass ?? "provider-failed" : null,
      routeDrift: assessment.routeDrift,
    });
  }
}
/** provider usage 的忠实投影（SDK 已解析字段），不落 HTTP 正文/请求/响应。 */
export function rawUsage(usage: Usage): Record<string, number | null> {
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens, reasoningTokens: usage.reasoningTokens };
}
