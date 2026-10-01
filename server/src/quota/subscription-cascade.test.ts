import { describe, expect, test } from "bun:test";
import { StringRecordId } from "surrealdb";
import type { PlanCycleDirective } from "../ai-allowance/plan-cycle";
import type { ProductEntitlementService } from "../product-entitlement/service";
import type { AiAllowancePlanCycleSynchronizer } from "../ai-allowance/plan-cycle";
import { SubscriptionEntitlementCascade } from "./subscription-cascade";
import type { EntitlementRefreshPort } from "./subscription-lifecycle";

type RefreshInput = Parameters<EntitlementRefreshPort["refreshWorkspace"]>[0];

function refreshInput(workspace: string, correlationId = "corr-1"): RefreshInput {
  return {
    workspace: new StringRecordId(workspace),
    at: new Date("2026-09-24T00:00:00.000Z") as never,
    operationKind: "provider_update",
    actorKind: "provider",
    correlationId,
    causationId: "provider_event:1",
  };
}

function directive(overrides: Partial<PlanCycleDirective> = {}): PlanCycleDirective {
  return {
    workspaceDb: "ws_team",
    usable: true,
    periodKey: "quota_subscription:team:2026-09-01T00:00:00.000Z",
    cycleAllowance: 200,
    expiresAt: "2026-10-01T00:00:00.000Z",
    periodStart: "2026-09-01T00:00:00.000Z",
    label: "夹具律师 Plus周期 AI 额度",
    ...overrides,
  };
}

describe("SubscriptionEntitlementCascade（LCA08 订阅级联）", () => {
  test("native 刷新后串接产品快照重算与周期额度同步，顺序固定", async () => {
    const calls: string[] = [];
    const inner: EntitlementRefreshPort = {
      async refreshWorkspace(input) {
        calls.push(`inner:${input.workspace.toString()}:${input.correlationId}`);
        return {};
      },
    };
    const products = {
      async refreshSubscriptionDriven(workspaceId: string, ctx: { correlationId: string }) {
        calls.push(`products:${workspaceId}:${ctx.correlationId}`);
        return { changed: true, planCycle: directive() };
      },
    };
    const planCycle = {
      async sync(directive: PlanCycleDirective, correlationId: string) {
        calls.push(`sync:${directive.periodKey}:${correlationId}`);
        return { kind: "created" as const, delta: directive.cycleAllowance, ruleVersion: "plan-cycle-rules-v1" as const };
      },
    };
    const cascade = new SubscriptionEntitlementCascade(
      inner, products as Pick<ProductEntitlementService, "refreshSubscriptionDriven">, planCycle as AiAllowancePlanCycleSynchronizer,
    );

    await cascade.refreshWorkspace(refreshInput("workspace:team", "corr-9"));
    expect(calls).toEqual([
      "inner:workspace:team:corr-9",
      "products:workspace:team:corr-9",
      "sync:quota_subscription:team:2026-09-01T00:00:00.000Z:corr-9",
    ]);
  });

  test("无周期额度指令（到期/保留模式）时跳过同步但不影响快照刷新", async () => {
    const calls: string[] = [];
    const inner: EntitlementRefreshPort = {
      async refreshWorkspace() {
        calls.push("inner");
        return {};
      },
    };
    const products = {
      async refreshSubscriptionDriven() {
        calls.push("products");
        return { changed: true, planCycle: null };
      },
    };
    const planCycle = {
      async sync() {
        calls.push("sync");
        return { kind: "none" as const, ruleVersion: "plan-cycle-rules-v1" as const };
      },
    };
    const cascade = new SubscriptionEntitlementCascade(
      inner, products as Pick<ProductEntitlementService, "refreshSubscriptionDriven">, planCycle as AiAllowancePlanCycleSynchronizer,
    );
    await cascade.refreshWorkspace(refreshInput("workspace:team"));
    expect(calls).toEqual(["inner", "products"]);
  });

  test("产品侧交付失败向上抛出，交给生命周期协调器重试", async () => {
    const inner: EntitlementRefreshPort = {
      async refreshWorkspace() {
        return {};
      },
    };
    const products = {
      async refreshSubscriptionDriven() {
        throw new Error("entitlement snapshot delivery failed");
      },
    };
    const planCycle = {
      async sync() {
        throw new Error("plan cycle sync must not run");
      },
    };
    const cascade = new SubscriptionEntitlementCascade(
      inner, products as Pick<ProductEntitlementService, "refreshSubscriptionDriven">, planCycle as AiAllowancePlanCycleSynchronizer,
    );
    await expect(cascade.refreshWorkspace(refreshInput("workspace:team"))).rejects.toThrow("entitlement snapshot delivery failed");
  });
});
