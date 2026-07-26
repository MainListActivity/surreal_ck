import { describe, expect, test } from "bun:test";
import { DateTime, StringRecordId } from "surrealdb";
import { commercialProductRules, SEEDED_PLAN_LIMITS } from "../db/quota-plan-rules";
import type { NativeQuotaClient } from "../db/native-quota/client";
import {
  runProvisioningQuotaSaga,
  type ProvisioningControlPlane,
  type ProvisioningWorkspaceRecord,
} from "./provisioning-saga";
import type { EntitlementBaseCandidate } from "../quota/entitlement-resolver";
import { compileQuotaPolicy } from "../quota/policy-compiler";

function plan() {
  const rules = commercialProductRules(SEEDED_PLAN_LIMITS.trial);
  return {
    planRevision: {
      id: new StringRecordId("quota_plan_revision:trial_v1"),
      template_kind: "trial" as const,
      rules,
    },
    rules,
  };
}

function controlPlane(overrides: Partial<ProvisioningControlPlane> = {}): ProvisioningControlPlane & {
  stages: string[];
} {
  const stages: string[] = [];
  const workspace: ProvisioningWorkspaceRecord = {
    id: new StringRecordId("workspace:ws_test"),
    dbName: "ws_test",
    slug: "test",
    name: "Test",
    ownerSubject: "user-1",
    status: "provisioning",
    stage: "reserved",
    quotaMigrationState: "not_started",
  };
  const base: ProvisioningControlPlane & { stages: string[] } = {
    stages,
    async reserveWorkspace() {
      return { kind: "reserved", workspace };
    },
    async loadPlan(planKey) {
      if (planKey === "missing") return null;
      return plan();
    },
    async persistResourceSource(input) {
      const subscriptionId = new StringRecordId("quota_subscription:1");
      const candidate: EntitlementBaseCandidate = {
        subscription: {
          id: subscriptionId,
          billing_account: new StringRecordId("billing_account:1"),
          source: "manual",
          status: "trialing",
          trial_start: new DateTime("2026-07-01T00:00:00.000Z"),
          trial_end: new DateTime("2026-08-15T00:00:00.000Z"),
        },
        item: {
          id: new StringRecordId("quota_subscription_item:1"),
          subscription: subscriptionId,
          workspace: input.workspace.id,
          plan_revision: input.planRevision.id,
          status: "active",
          effective_from: new DateTime("2026-07-01T00:00:00.000Z"),
        },
        planRevision: input.planRevision,
      };
      return candidate;
    },
    async persistEntitlementAndProjection(input) {
      return {
        entitlementId: input.entitlement.id,
        projectionId: input.projection.id,
      };
    },
    async markStage(input) {
      stages.push(`${input.stage}:${input.status ?? ""}:${input.quotaMigrationState ?? ""}`);
    },
    async markAppliedFromNative() {
      stages.push("applied-native");
    },
    async createPhysicalDatabase() {
      return { kind: "created" };
    },
    async dropPhysicalDatabase() {
      stages.push("dropped");
    },
    ...overrides,
  };
  return base;
}

function nativeMatching(): NativeQuotaClient {
  const p = plan();
  const entitlement = {
    id: new StringRecordId("resource_entitlement:ws_test_v1"),
    workspace: new StringRecordId("workspace:ws_test"),
    revision: 1,
    source_type: "trial" as const,
    plan_revision: p.planRevision.id,
    service_mode: "standard" as const,
    rules: p.rules,
    source_digest: "x",
    effective_at: new DateTime("2026-07-01T00:00:00.000Z"),
    resolved_at: new DateTime("2026-07-01T00:00:00.000Z"),
    correlation_id: "c",
  };
  const compiled = compileQuotaPolicy({
    projection: {
      id: new StringRecordId("quota_policy_projection:ws_test_v1"),
      revision: 1,
      createdAt: new DateTime("2026-07-01T00:00:00.000Z"),
    },
    entitlement,
  });
  return {
    async info(database) {
      return {
        database,
        format_version: 1,
        latest_change: null,
        observed_at: "2026-07-26T00:00:00.000Z",
        policy: { generation: 1, rules: compiled.projection.rules },
        ledger: { state: "ready", usage_trusted: true, active_epoch: 1 },
        usage: {
          table_buckets: [],
          tables: [],
          unmatched: { table: [], field: [], record: [] },
        },
      } as any;
    },
    async applyPolicy() {
      return {
        format_version: 1,
        operation_id: "op",
        operation: "define_quota",
        database: "ws_test",
        changed: true,
        before: { active_epoch: null, generation: null, ledger_state: "uninitialized" },
        after: { active_epoch: 1, generation: 1, ledger_state: "ready" },
      } as any;
    },
    async rebuild() {
      return {
        format_version: 1,
        operation_id: "rb",
        operation: "rebuild_quota",
        database: "ws_test",
        changed: true,
        before: { active_epoch: null, generation: null, ledger_state: "uninitialized" },
        after: { active_epoch: 1, generation: 1, ledger_state: "ready" },
        duration_ms: 1,
        scanned: { table: 0, field: 0, record: 0 },
      } as any;
    },
  };
}

describe("runProvisioningQuotaSaga", () => {
  test("requires explicit planKey", async () => {
    const result = await runProvisioningQuotaSaga(
      controlPlane(),
      nativeMatching(),
      {
        subject: "user-1",
        email: "a@b.c",
        name: "Test",
        slug: "test",
        dbName: "ws_test",
        resourceSource: { planKey: "" },
      },
      { now: new DateTime("2026-07-26T00:00:00.000Z") },
    );
    expect(result.kind).toBe("no-resource-source");
  });

  test("applies native policy and marks native_verified before templates", async () => {
    const cp = controlPlane();
    const result = await runProvisioningQuotaSaga(
      cp,
      nativeMatching(),
      {
        subject: "user-1",
        email: "a@b.c",
        name: "Test",
        slug: "test",
        dbName: "ws_test",
        resourceSource: { planKey: "trial", sourceKind: "trial" },
      },
      {
        now: new DateTime("2026-07-26T00:00:00.000Z"),
        nextIds: () => ({
          entitlementId: new StringRecordId("resource_entitlement:ws_test_v1"),
          projectionId: new StringRecordId("quota_policy_projection:ws_test_v1"),
          entitlementRevision: 1,
          projectionRevision: 1,
        }),
      },
    );

    expect(result.kind).toBe("ready_for_template");
    if (result.kind !== "ready_for_template") throw new Error("expected ready");
    expect(result.workspace.quotaMigrationState).toBe("native_verified");
    expect(cp.stages.some((s) => s.includes("policy_applied") && s.includes("native_verified"))).toBe(
      true,
    );
    expect(cp.stages).toContain("applied-native");
  });

  test("readback mismatch stays provisioning_error and never ready_for_template", async () => {
    const badNative: NativeQuotaClient = {
      ...nativeMatching(),
      async info(database) {
        return {
          database,
          format_version: 1,
          latest_change: null,
          observed_at: "2026-07-26T00:00:00.000Z",
          policy: null,
          ledger: { state: "ready", usage_trusted: true, active_epoch: 1 },
          usage: {
            table_buckets: [],
            tables: [],
            unmatched: { table: [], field: [], record: [] },
          },
        } as any;
      },
    };

    const result = await runProvisioningQuotaSaga(
      controlPlane(),
      badNative,
      {
        subject: "user-1",
        email: "a@b.c",
        name: "Test",
        slug: "test",
        dbName: "ws_test",
        resourceSource: { planKey: "trial", sourceKind: "trial" },
      },
      { now: new DateTime("2026-07-26T00:00:00.000Z") },
    );

    expect(result.kind).toBe("provisioning_error");
  });
});
