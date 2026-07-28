import { describe, expect, test } from "bun:test";
import type {
  ControlPlaneObject,
  PlatformOperatorCapability,
} from "@surreal-ck/shared/native-quota";
import { DateTime, StringRecordId } from "surrealdb";
import {
  operatorIntentDigest,
  QuotaLifecycleCoordinator,
  QuotaLifecycleError,
  requiredCapabilityForIntent,
  type EntitlementRefreshPort,
  type OperatorIntentClaim,
  type OperatorIntentSubmission,
  type ProviderApplyResult,
  type ProviderEventClaim,
  type QuotaLifecycleStore,
} from "./subscription-lifecycle";

const now = new DateTime("2026-08-01T00:00:00.000Z");

function id(value: string): StringRecordId {
  return new StringRecordId(value);
}

function operatorSubmission(
  overrides: Partial<OperatorIntentSubmission> = {},
): OperatorIntentSubmission {
  return {
    kind: "subscription_upsert",
    actorSubject: "operator:alice",
    actorCapability: "subscription.manage",
    requestId: "request-1",
    workspace: id("workspace:acme"),
    billingAccount: id("billing_account:acme"),
    customerReason: "客户升级到 Pro",
    operatorReason: "已核验合同和付款状态",
    effectiveAt: now,
    input: {
      mode: "manual_assignment",
      plan_revision: id("quota_plan_revision:pro_v1"),
    },
    impactPreview: {
      table_limit: { before: 20, after: 100 },
    },
    correlationId: "corr-1",
    ...overrides,
  };
}

function providerClaim(
  overrides: Partial<ProviderEventClaim> = {},
): ProviderEventClaim {
  return {
    event: id("provider_event_inbox:event_1"),
    state: id("provider_event_state:event_1"),
    provider: "stripe",
    workerId: "worker-a",
    fencingToken: 1,
    attemptNumber: 1,
    snapshot: {
      billingAccount: id("billing_account:acme"),
      providerSubscriptionId: "sub_1",
      sourceRevision: 2,
      status: "active",
      cancelAtPeriodEnd: false,
    },
    correlationId: "corr-provider-1",
    ...overrides,
  };
}

function operatorClaim(
  overrides: Partial<OperatorIntentClaim> = {},
): OperatorIntentClaim {
  return {
    intent: id("quota_operator_intent:intent_1"),
    state: id("quota_operator_intent_state:intent_1"),
    kind: "subscription_upsert",
    workspace: id("workspace:acme"),
    billingAccount: id("billing_account:acme"),
    actorSubject: "operator:alice",
    authorizedCapability: "subscription.manage",
    customerReason: "客户升级到 Pro",
    operatorReason: "已核验合同和付款状态",
    effectiveAt: now,
    input: {
      mode: "manual_assignment",
      plan_revision: id("quota_plan_revision:pro_v1"),
    },
    requestId: "request-1",
    correlationId: "corr-1",
    workerId: "worker-a",
    fencingToken: 1,
    attemptNumber: 1,
    ...overrides,
  };
}

class MemoryLifecycleStore implements QuotaLifecycleStore {
  persistedIntent:
    | (OperatorIntentSubmission & {
        requiredCapability: PlatformOperatorCapability;
        inputDigest: string;
        now: DateTime;
      })
    | undefined;
  providerClaim?: ProviderEventClaim;
  operatorClaim?: OperatorIntentClaim;
  providerApply: ProviderApplyResult = {
    kind: "applied",
    subscription: id("quota_subscription:sub_1"),
    providerRevision: 2,
    workspaces: [id("workspace:acme")],
  };
  operatorWorkspaces: readonly StringRecordId[] = [id("workspace:acme")];
  providerFailure:
    | Readonly<{
        errorCode: string;
        errorDetails: ControlPlaneObject;
        nextAttemptAt?: DateTime;
        failedAt: DateTime;
      }>
    | undefined;
  operatorFailure:
    | Readonly<{
        errorCode: string;
        errorDetails: ControlPlaneObject;
        nextAttemptAt?: DateTime;
        failedAt: DateTime;
      }>
    | undefined;
  providerApplyError?: Error;
  operatorApplyError?: Error;

  async ingestProviderEvent() {
    return {
      kind: "accepted" as const,
      event: id("provider_event_inbox:event_1"),
    };
  }

  async claimProviderEvent() {
    const claim = this.providerClaim;
    this.providerClaim = undefined;
    return claim;
  }

  async applyProviderSnapshot(): Promise<ProviderApplyResult> {
    if (this.providerApplyError) throw this.providerApplyError;
    return this.providerApply;
  }

  async settleProviderEvent(): Promise<boolean> {
    return true;
  }

  async failProviderEvent(
    _claim: ProviderEventClaim,
    failure: NonNullable<MemoryLifecycleStore["providerFailure"]>,
  ): Promise<boolean> {
    this.providerFailure = failure;
    return true;
  }

  async persistOperatorIntent(
    input: NonNullable<MemoryLifecycleStore["persistedIntent"]>,
  ) {
    this.persistedIntent = input;
    return {
      kind: "accepted" as const,
      intent: id("quota_operator_intent:intent_1"),
    };
  }

  async claimOperatorIntent() {
    const claim = this.operatorClaim;
    this.operatorClaim = undefined;
    return claim;
  }

  async applyOperatorMutation() {
    if (this.operatorApplyError) throw this.operatorApplyError;
    return { workspaces: this.operatorWorkspaces };
  }

  async settleOperatorIntent(): Promise<boolean> {
    return true;
  }

  async failOperatorIntent(
    _claim: OperatorIntentClaim,
    failure: NonNullable<MemoryLifecycleStore["operatorFailure"]>,
  ): Promise<boolean> {
    this.operatorFailure = failure;
    return true;
  }
}

class MemoryRefresher implements EntitlementRefreshPort {
  readonly calls: Parameters<EntitlementRefreshPort["refreshWorkspace"]>[0][] =
    [];
  error?: Error;

  async refreshWorkspace(
    input: Parameters<EntitlementRefreshPort["refreshWorkspace"]>[0],
  ) {
    this.calls.push(input);
    if (this.error) throw this.error;
    return {
      entitlementOperation: id("entitlement_operation:one"),
      materializationOperation: id("quota_materialization_operation:one"),
    };
  }
}

function coordinator(
  store: MemoryLifecycleStore,
  refresher: MemoryRefresher,
  onWake?: () => void,
): QuotaLifecycleCoordinator {
  return new QuotaLifecycleCoordinator(
    store,
    refresher,
    "worker-a",
    onWake ? { wake: onWake } : undefined,
    { clock: { now: () => now }, retryMs: 5_000 },
  );
}

describe("QuotaLifecycleCoordinator", () => {
  test("operator HTTP boundary persists an audited intent only", async () => {
    const store = new MemoryLifecycleStore();
    const refresher = new MemoryRefresher();
    let wakes = 0;
    const service = coordinator(store, refresher, () => {
      wakes += 1;
    });
    const input = operatorSubmission();

    await expect(service.submitOperatorIntent(input)).resolves.toMatchObject({
      kind: "accepted",
    });

    expect(store.persistedIntent?.requiredCapability).toBe(
      "subscription.manage",
    );
    expect(store.persistedIntent?.inputDigest).toBe(
      operatorIntentDigest(input),
    );
    expect(refresher.calls).toHaveLength(0);
    expect(wakes).toBe(0);
  });

  test("caller cannot substitute one independently granted capability for another", async () => {
    const service = coordinator(
      new MemoryLifecycleStore(),
      new MemoryRefresher(),
    );

    await expect(service.submitOperatorIntent(operatorSubmission({
      actorCapability: "override.manage",
    }))).rejects.toMatchObject({
      code: "operator_capability_mismatch",
    });
    expect(requiredCapabilityForIntent("subscription_upsert")).toBe(
      "subscription.manage",
    );
    expect(requiredCapabilityForIntent("override_schedule")).toBe(
      "override.manage",
    );
    expect(requiredCapabilityForIntent("ledger_rebuild")).toBe(
      "ledger.rebuild",
    );
  });

  test("provider snapshot refreshes every affected workspace before settlement", async () => {
    const store = new MemoryLifecycleStore();
    store.providerClaim = providerClaim();
    store.providerApply = {
      ...store.providerApply,
      workspaces: [id("workspace:acme"), id("workspace:beta")],
    };
    const refresher = new MemoryRefresher();
    let wakes = 0;

    await expect(
      coordinator(store, refresher, () => {
        wakes += 1;
      }).processNextProviderEvent(),
    ).resolves.toBe("processed");

    expect(refresher.calls.map((call) => call.workspace.toString())).toEqual([
      "workspace:acme",
      "workspace:beta",
    ]);
    expect(refresher.calls.every((call) =>
      call.operationKind === "provider_update"
      && call.actorKind === "provider"
    )).toBeTrue();
    expect(wakes).toBe(1);
  });

  test("terminal failure has no retry timestamp; retryable failure receives backoff", async () => {
    const terminalStore = new MemoryLifecycleStore();
    terminalStore.operatorClaim = operatorClaim();
    terminalStore.operatorApplyError = new QuotaLifecycleError(
      "operator_intent_invalid",
      "bad input",
    );
    await expect(
      coordinator(terminalStore, new MemoryRefresher())
        .processNextOperatorIntent(),
    ).resolves.toBe("failed");
    expect(terminalStore.operatorFailure?.nextAttemptAt).toBeUndefined();

    const retryStore = new MemoryLifecycleStore();
    retryStore.providerClaim = providerClaim();
    retryStore.providerApplyError = new QuotaLifecycleError(
      "provider_unavailable",
      "temporary outage",
      true,
    );
    await expect(
      coordinator(retryStore, new MemoryRefresher())
        .processNextProviderEvent(),
    ).resolves.toBe("retry_scheduled");
    expect(retryStore.providerFailure?.nextAttemptAt?.toString()).toBe(
      "2026-08-01T00:00:05.000Z",
    );
  });
});
