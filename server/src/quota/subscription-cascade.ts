import type { AiAllowancePlanCycleSynchronizer, PlanCycleDirective } from "../ai-allowance/plan-cycle";
import type { ProductEntitlementService } from "../product-entitlement/service";
import type { EntitlementRefreshPort, EntitlementRefreshResult } from "./subscription-lifecycle";

/**
 * LCA08 订阅级联：所有商业入口（provider 事件、受保护运营意图、时间边界
 * sweep）汇聚的 EntitlementRefreshPort 之上，串接两件产品侧收尾——
 *
 * 1. 重算 `workspace_product_entitlement` 聚合快照（内容/AI 动作/功能随
 *    订阅事实变化，digest 幂等，旧快照按 digest 回指）；
 * 2. 按版本化 plan-cycle 规则同步套餐周期 AI 额度桶（新周期新桶不结转、
 *    升级补正差额、到期/保留模式暂停新收费授予但不触碰既有桶）。
 *
 * 产品侧交付失败会让整个 refreshWorkspace 抛错，由生命周期协调器按
 * retryable 失败重试；native 侧重放时返回 unchanged，产品侧幂等收敛。
 */
export class SubscriptionEntitlementCascade implements EntitlementRefreshPort {
  constructor(
    private readonly inner: EntitlementRefreshPort,
    private readonly products: Pick<ProductEntitlementService, "refreshSubscriptionDriven">,
    private readonly planCycle: AiAllowancePlanCycleSynchronizer,
  ) {}

  async refreshWorkspace(
    input: Parameters<EntitlementRefreshPort["refreshWorkspace"]>[0],
  ): Promise<EntitlementRefreshResult> {
    const result = await this.inner.refreshWorkspace(input);
    const { planCycle: directive } = await this.products.refreshSubscriptionDriven(
      input.workspace.toString(),
      { correlationId: input.correlationId, reason: input.reason },
    );
    if (directive) {
      await this.planCycle.sync(directive, input.correlationId);
    }
    return result;
  }
}

export type { PlanCycleDirective };
