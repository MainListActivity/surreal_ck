import { describe, expect, test } from "bun:test";
import {
  NATIVE_QUOTA_EXPECTED_CONTRACT,
  type NativeQuotaInfo,
  type NativeQuotaOperationResult,
  type NativeQuotaRule,
  type QuotaPolicyProjectionRecord,
} from "@surreal-ck/shared/native-quota";
import { DateTime, StringRecordId } from "surrealdb";
import type {
  NativeQuotaClient,
  NativeQuotaPolicyApplyInput,
} from "../db/native-quota/client";
import { canonicalNativePolicyDigest } from "./policy-compiler";
import {
  QuotaReconciler,
  type MaterializationLease,
  type MaterializationSettlement,
  type QuotaMaterializationStore,
} from "./reconciler";

const now = new DateTime("2026-08-02T00:00:00.000Z");
const targetRules: readonly NativeQuotaRule[] = [{
  rule_id: "records",
  resource: "record",
  selector: { kind: "regex", pattern: "^ent_" },
  limit: { kind: "finite", value: 100 },
}];
const otherRules: readonly NativeQuotaRule[] = [{
  rule_id: "records",
  resource: "record",
  selector: { kind: "regex", pattern: "^ent_" },
  limit: { kind: "finite", value: 200 },
}];

function id(value: string): StringRecordId {
  return new StringRecordId(value);
}

function info(input: {
  rules?: readonly NativeQuotaRule[];
  generation?: number;
  ledger?: NativeQuotaInfo["ledger"]["state"];
  trusted?: boolean;
  operationId?: string;
} = {}): NativeQuotaInfo {
  const ledger = input.ledger ?? "ready";
  const trusted = input.trusted ?? ledger === "ready";
  return {
    database: "ws_acme",
    format_version: 1,
    latest_change: input.operationId
      ? {
          action: "define_quota",
          actor: "root",
          changed_at: "2026-08-02T00:00:00.000Z",
          generation: input.generation ?? 1,
          operation_id: input.operationId,
        }
      : null,
    ledger: {
      active_epoch: ledger === "ready" ? 1 : null,
      state: ledger,
      usage_trusted: trusted,
    },
    observed_at: "2026-08-02T00:00:00.000Z",
    policy: input.rules
      ? {
          generation: input.generation ?? 1,
          rules: [...input.rules],
        }
      : null,
    usage: trusted
      ? {
          table_buckets: [],
          tables: [],
          unmatched: { table: [], field: [], record: [] },
        }
      : null,
  };
}

function operationResult(
  operation: "define_quota" | "alter_quota" | "rebuild_quota",
  generation: number,
): NativeQuotaOperationResult {
  const base = {
    format_version: 1,
    operation_id: `${operation}-${generation}`,
    operation,
    database: "ws_acme",
    changed: true,
    before: {
      active_epoch: 1,
      generation: generation - 1,
      ledger_state: "ready" as const,
    },
    after: {
      active_epoch: 1,
      generation,
      ledger_state: "ready" as const,
    },
  };
  return operation === "rebuild_quota"
    ? {
        ...base,
        operation,
        duration_ms: 1,
        scanned: { table: 1, field: 1, record: 1 },
      }
    : base;
}

function projection(
  rules: readonly NativeQuotaRule[] = targetRules,
): QuotaPolicyProjectionRecord {
  return {
    id: id("quota_policy_projection:acme_v2"),
    workspace: id("workspace:acme"),
    entitlement: id("resource_entitlement:acme_v2"),
    revision: 2,
    compiler_version: "quota-policy-compiler-v1",
    native_capability: NATIVE_QUOTA_EXPECTED_CONTRACT.capabilityName,
    native_contract_major: 1,
    info_format_version: 1,
    rules,
    rule_labels: [],
    canonical_digest: canonicalNativePolicyDigest(rules),
    created_at: now,
    correlation_id: "corr-acme-v2",
  };
}

function lease(
  overrides: Partial<MaterializationLease> = {},
): MaterializationLease {
  const selectedProjection = projection();
  return {
    operation: id("quota_materialization_operation:acme_v2"),
    workspace: id("workspace:acme"),
    database: "ws_acme",
    entitlement: selectedProjection.entitlement,
    projection: selectedProjection,
    serviceMode: "standard",
    desiredEntitlement: selectedProjection.entitlement,
    desiredProjection: selectedProjection.id,
    applied: {
      entitlement: id("resource_entitlement:acme_v1"),
      projection: id("quota_policy_projection:acme_v1"),
      canonicalDigest: canonicalNativePolicyDigest(otherRules),
      nativeGeneration: 1,
    },
    workspaceStatus: "active",
    autoReconcile: true,
    allowExternalDriftOverwrite: false,
    executionStarted: false,
    workerId: "worker-a",
    fencingToken: 1,
    attemptNumber: 1,
    startedAt: now,
    leaseExpiresAt: new DateTime("2026-08-02T00:00:30.000Z"),
    correlationId: "corr-acme-v2",
    ...overrides,
  };
}

class FakeStore implements QuotaMaterializationStore {
  readonly settlements: MaterializationSettlement[] = [];
  renewResult = true;
  settleResult: "committed" | "lease_lost" = "committed";
  renewals = 0;

  async renewMaterializationLease(): Promise<boolean> {
    this.renewals += 1;
    return this.renewResult;
  }

  async settleMaterialization(
    _lease: MaterializationLease,
    settlement: MaterializationSettlement,
  ): Promise<"committed" | "lease_lost"> {
    this.settlements.push(settlement);
    return this.settleResult;
  }
}

class FakeNativeClient implements NativeQuotaClient {
  readonly applyInputs: NativeQuotaPolicyApplyInput[] = [];
  infoResults: Array<NativeQuotaInfo | Error> = [];
  applyResults: Array<NativeQuotaOperationResult | Error> = [];
  rebuildResults: Array<NativeQuotaOperationResult | Error> = [];

  async info(): Promise<NativeQuotaInfo> {
    const value = this.infoResults.shift();
    if (!value) throw new Error("missing fake INFO");
    if (value instanceof Error) throw value;
    return value;
  }

  async applyPolicy(
    input: NativeQuotaPolicyApplyInput,
  ): Promise<NativeQuotaOperationResult> {
    this.applyInputs.push(input);
    const value = this.applyResults.shift();
    if (!value) throw new Error("missing fake apply result");
    if (value instanceof Error) throw value;
    return value;
  }

  async rebuild(): Promise<NativeQuotaOperationResult> {
    const value = this.rebuildResults.shift();
    if (!value) throw new Error("missing fake rebuild result");
    if (value instanceof Error) throw value;
    return value;
  }
}

function reconciler(store: FakeStore, native: FakeNativeClient): QuotaReconciler {
  return new QuotaReconciler(store, native, {
    clock: { now: () => now },
    random: () => 0.5,
  });
}

describe("QuotaReconciler", () => {
  test("INFO-first: identical desired policy succeeds without DDL", async () => {
    const store = new FakeStore();
    const native = new FakeNativeClient();
    native.infoResults.push(info({
      rules: targetRules,
      generation: 7,
      operationId: "existing-target",
    }));

    const outcome = await reconciler(store, native).reconcile(lease());

    expect(outcome).toMatchObject({ kind: "succeeded", ddlExecuted: false });
    expect(native.applyInputs).toHaveLength(0);
    expect(store.settlements[0]).toMatchObject({
      kind: "succeeded",
      observedAfterGeneration: 7,
      observedAfterDigest: canonicalNativePolicyDigest(targetRules),
    });
  });

  test("missing policy is fail-open drift but is automatically defined and read back", async () => {
    const store = new FakeStore();
    const native = new FakeNativeClient();
    native.infoResults.push(
      info(),
      info({ rules: targetRules, generation: 1, operationId: "define-1" }),
    );
    native.applyResults.push(operationResult("define_quota", 1));

    const outcome = await reconciler(store, native).reconcile(lease());

    expect(outcome).toMatchObject({ kind: "succeeded", ddlExecuted: true });
    expect(native.applyInputs[0]).toMatchObject({
      database: "ws_acme",
      expectedGeneration: undefined,
    });
  });

  test("commit unknown reads INFO and recognizes a committed target without replay", async () => {
    const store = new FakeStore();
    const native = new FakeNativeClient();
    native.infoResults.push(
      info({ rules: otherRules, generation: 1 }),
      info({ rules: targetRules, generation: 2, operationId: "committed" }),
    );
    native.applyResults.push(new Error("socket closed after write"));

    const outcome = await reconciler(store, native).reconcile(lease());

    expect(outcome).toMatchObject({ kind: "succeeded", ddlExecuted: true });
    expect(native.applyInputs).toHaveLength(1);
    expect(store.settlements[0]).toMatchObject({
      kind: "succeeded",
      nativeOperationId: "committed",
      observedAfterGeneration: 2,
    });
  });

  test("commit unknown with unchanged INFO schedules backoff instead of replaying DDL", async () => {
    const store = new FakeStore();
    const native = new FakeNativeClient();
    native.infoResults.push(
      info({ rules: otherRules, generation: 1 }),
      info({ rules: otherRules, generation: 1 }),
    );
    native.applyResults.push(new Error("connection outcome unknown"));

    const outcome = await reconciler(store, native).reconcile(lease());

    expect(outcome).toMatchObject({
      kind: "retry_scheduled",
      errorCode: "native_quota_transport_error",
    });
    expect(native.applyInputs).toHaveLength(1);
    expect(store.settlements[0]).toMatchObject({
      kind: "retry",
      outcome: "commit_unknown",
      observedAfterGeneration: 1,
    });
  });

  test("unknown policy/generation drift stops automatic overwrite", async () => {
    const store = new FakeStore();
    const native = new FakeNativeClient();
    const unknownRules = [{
      ...otherRules[0]!,
      limit: { kind: "finite" as const, value: 333 },
    }];
    native.infoResults.push(info({ rules: unknownRules, generation: 3 }));

    const outcome = await reconciler(store, native).reconcile(lease());

    expect(outcome).toMatchObject({
      kind: "external_drift",
      ddlExecuted: false,
      errorCode: "external_drift",
    });
    expect(native.applyInputs).toHaveLength(0);
    expect(store.settlements[0]).toMatchObject({
      kind: "terminal",
      syncState: "external_drift",
    });
  });

  test("explicit drift reapply uses the freshly observed generation guard", async () => {
    const store = new FakeStore();
    const native = new FakeNativeClient();
    native.infoResults.push(
      info({ rules: otherRules, generation: 9 }),
      info({ rules: targetRules, generation: 10 }),
    );
    native.applyResults.push(operationResult("alter_quota", 10));

    const outcome = await reconciler(store, native).reconcile(lease({
      allowExternalDriftOverwrite: true,
    }));

    expect(outcome.kind).toBe("succeeded");
    expect(native.applyInputs[0]?.expectedGeneration).toBe(9);
  });

  test("corrupt ledger is rebuilt before a matching policy can be applied", async () => {
    const store = new FakeStore();
    const native = new FakeNativeClient();
    native.infoResults.push(
      info({
        rules: targetRules,
        generation: 4,
        ledger: "corrupt",
        trusted: false,
      }),
      info({ rules: targetRules, generation: 4, operationId: "existing" }),
    );
    native.rebuildResults.push(operationResult("rebuild_quota", 4));

    const outcome = await reconciler(store, native).reconcile(lease());

    expect(outcome).toMatchObject({
      kind: "succeeded",
      ddlExecuted: false,
      rebuilt: true,
    });
    expect(native.applyInputs).toHaveLength(0);
    expect(store.renewals).toBe(1);
  });

  test("incompatible projection fails before INFO or policy mutation", async () => {
    const store = new FakeStore();
    const native = new FakeNativeClient();
    const incompatible = {
      ...projection(),
      native_contract_major: 2,
    };

    const outcome = await reconciler(store, native).reconcile(lease({
      projection: incompatible,
      desiredProjection: incompatible.id,
    }));

    expect(outcome).toMatchObject({
      kind: "failed",
      errorCode: "native_quota_contract_incompatible",
    });
    expect(native.infoResults).toHaveLength(0);
    expect(native.applyInputs).toHaveLength(0);
  });

  test("structured permanent policy rejection stops automatic retries", async () => {
    const store = new FakeStore();
    const native = new FakeNativeClient();
    native.infoResults.push(
      info({ rules: otherRules, generation: 1 }),
      info({ rules: otherRules, generation: 1 }),
    );
    native.applyResults.push(Object.assign(new Error("policy rejected"), {
      kind: "Quota",
      details: {
        code: "quota_policy_invalid",
        retryable: false,
        details: { rule_id: "records" },
      },
    }));

    const outcome = await reconciler(store, native).reconcile(lease());

    expect(outcome).toMatchObject({
      kind: "failed",
      errorCode: "quota_policy_invalid",
    });
    expect(store.settlements[0]).toMatchObject({
      kind: "terminal",
      errorRetryable: false,
    });
  });

  test("stale unexecuted operation is superseded before touching the database", async () => {
    const store = new FakeStore();
    const native = new FakeNativeClient();
    const outcome = await reconciler(store, native).reconcile(lease({
      desiredProjection: id("quota_policy_projection:acme_v3"),
    }));

    expect(outcome.kind).toBe("superseded");
    expect(native.infoResults).toHaveLength(0);
    expect(store.settlements[0]).toMatchObject({
      kind: "superseded",
      supersededBy: id("quota_policy_projection:acme_v3"),
    });
  });

  test("executed old operation completes readback before the latest desired follows", async () => {
    const store = new FakeStore();
    const native = new FakeNativeClient();
    native.infoResults.push(info({ rules: targetRules, generation: 2 }));

    const outcome = await reconciler(store, native).reconcile(lease({
      desiredProjection: id("quota_policy_projection:acme_v3"),
      executionStarted: true,
    }));

    expect(outcome.kind).toBe("succeeded");
    expect(store.settlements[0]?.kind).toBe("succeeded");
  });

  test("retryable INFO failure persists deterministic backoff and exhausts budget", async () => {
    const store = new FakeStore();
    const native = new FakeNativeClient();
    native.infoResults.push(new Error("temporarily unavailable"));

    const outcome = await reconciler(store, native).reconcile(lease({
      attemptNumber: 8,
    }));

    expect(outcome).toMatchObject({
      kind: "failed",
      errorCode: "native_quota_transport_error",
    });
    expect(store.settlements[0]).toMatchObject({
      kind: "retry",
      exhausted: true,
      errorRetryable: true,
    });
  });

  test("lost fencing lease prevents native mutation and records lease loss", async () => {
    const store = new FakeStore();
    store.renewResult = false;
    const native = new FakeNativeClient();
    native.infoResults.push(info());

    const outcome = await reconciler(store, native).reconcile(lease());

    expect(outcome.kind).toBe("lease_lost");
    expect(native.applyInputs).toHaveLength(0);
    expect(store.settlements[0]?.kind).toBe("lease_lost");
  });
});
