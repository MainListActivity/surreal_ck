import { internalScope, inInternalScope, type InternalScope } from "./context";
import { InternalAiStore } from "./store";
import { actualCost, tariffFor, worstCost, type Tariff, type Usage } from "./pricing";
import type { RecordId } from "surrealdb";
export type AttemptTicket = { id: RecordId; tariff: Tariff };
/** Interface：bind/inRun保持身份；begin/finish包住实际provider尝试。没有客户可设置的budget字段。 */
export class InternalAiGate {
  constructor(readonly store: InternalAiStore) {}
  async bind(subject: string, database: string, run: string, key?: string): Promise<InternalScope | undefined> {
    const activity = await this.store.binding(subject, database);
    // 恢复必须保留旧run活动绑定，撤销账号binding后也不能变成非计量run。
    if (!activity) {
      const previous = await this.store.runActivity(subject, database, run);
      if (previous) throw new Error("internal-ai-binding-revoked");
      return undefined;
    }
    return this.store.scope(activity, subject, database, run, key);
  }
  inRun<T>(scope: InternalScope | undefined, work: () => T): T { return scope ? inInternalScope(scope, work) : work(); }
  async begin(stage: string, provider: string, model: string, endpoint: string): Promise<AttemptTicket | undefined> {
    const scope = internalScope();
    if (!scope) return undefined;
    let tariff: Tariff | undefined;
    try { tariff = tariffFor(provider, model, endpoint); } catch { /* unknown URL denies */ }
    if (!tariff) throw new Error("internal-ai-price-or-bound-unavailable");
    const row = await this.store.reserve(scope, stage, tariff, worstCost(tariff));
    // 持久sent标记先于传输；此后任意异常均保留预留。
    await this.store.sent(row.id);
    return { id: row.id, tariff };
  }
  async finish(ticket: AttemptTicket | undefined, usage: Usage | null, model: string | null, request: string | null, failed: boolean): Promise<void> {
    if (!ticket) return;
    await this.store.finish(ticket.id, { usage, actualModel: model, requestId: request, cost: usage ? actualCost(ticket.tariff, usage, model) : null, failed });
  }
}
