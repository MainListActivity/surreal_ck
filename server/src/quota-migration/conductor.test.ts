import { describe, expect, test } from "bun:test";
import {
  DateTime,
  StringRecordId,
} from "surrealdb";
import { commercialProductRules } from "../db/quota-plan-rules";
import { migrationChecksum } from "./model";
import {
  classifyCommitUnknownReadback,
  LegacyQuotaMigrationConductor,
  type QuotaMigrationStorePort,
} from "./conductor";
import type {
  QuotaMigrationAssignment,
  QuotaMigrationAssignmentManifest,
} from "@surreal-ck/shared/native-quota";
import type {
  QuotaMigrationRun,
} from "./store";

const now = new DateTime("2026-07-29T00:00:00.000Z");
const workspace = {
  id: new StringRecordId("workspace:demo"),
  slug: "demo",
  database: "ws_demo",
  status: "active" as const,
};
const plan = {
  id: new StringRecordId("quota_plan_revision:plus_v1"),
  templateKind: "commercial" as const,
  rules: commercialProductRules({ tables: 1, fields: 3, records: 2 }),
};
const assignment: QuotaMigrationAssignment = {
  workspace_id: "workspace:demo",
  workspace_slug: "demo",
  database: "ws_demo",
  billing_account_id: "billing_account:acme",
  plan_revision_id: "quota_plan_revision:plus_v1",
  source: "manual",
  effective_at: "2026-07-29T00:00:00.000Z",
  rollout_class: "internal",
  evidence_reference: "support-contract-42",
};

function run(overrides: Partial<QuotaMigrationRun> = {}): QuotaMigrationRun {
  return {
    id: new StringRecordId("quota_migration_run:demo"),
    runKey: "demo",
    inventoryChecksum: `sha256:${"1".repeat(64)}`,
    state: "inventory_ready",
    publicReopenReady: false,
    ...overrides,
  };
}

function fakeStore(
  overrides: Partial<QuotaMigrationStorePort>,
): QuotaMigrationStorePort {
  const unavailable = async () => {
    throw new Error("unexpected store call");
  };
  return {
    listWorkspaces: unavailable,
    loadPlanRevision: unavailable,
    persistInventory: unavailable,
    findRun: unavailable,
    inventoryBlockers: unavailable,
    manifestContext: unavailable,
    persistAssignments: unavailable,
    applyAssignmentAuthority: unavailable,
    listOperations: unavailable,
    loadProjection: unavailable,
    setMaintenanceEvidence: unavailable,
    setWorkspaceState: unavailable,
    markNativePolicyActive: unavailable,
    markReadyToReopen: unavailable,
    startCohort: unavailable,
    claimWorkspace: unavailable,
    settleWorkspace: unavailable,
    observeCohort: unavailable,
    completeCohort: unavailable,
    recordSignal: unavailable,
    pauseRun: unavailable,
    resumeRun: unavailable,
    abortRun: unavailable,
    markAllNativeVerified: unavailable,
    markCleanupEvidence: unavailable,
    markCleanupEligible: unavailable,
    ...overrides,
  } as QuotaMigrationStorePort;
}

function workspaceSession() {
  return {
    async query(sql: string) {
      if (sql === "INFO FOR DATABASE STRUCTURE;") {
        return [{
          tables: [{ name: "ent_case" }, { name: "sheet" }],
        }];
      }
      if (sql.startsWith("INFO FOR TABLE `ent_case` STRUCTURE")) {
        return [
          { fields: [{ name: "title" }, { name: "status" }] },
          [{ count: 3 }],
        ];
      }
      if (sql.startsWith("INFO FOR TABLE `sheet` STRUCTURE")) {
        return [
          { fields: [{ name: "table_name" }] },
          [{ count: 1 }],
        ];
      }
      if (sql.includes("FROM resource_quota_plan")) {
        return [
          [{
            id: "resource_quota_plan:plus",
            key: "plus",
            max_sheets: 1,
            max_fields_per_sheet: 3,
            max_records_per_sheet: 2,
          }],
          [{
            plan: "resource_quota_plan:plus",
            sheet_count: 1,
          }],
          [{
            sheet: "sheet:case",
            record_count: 99,
          }],
          [{ id: "sheet:case", table_name: "ent_case" }],
        ];
      }
      if (sql.startsWith("RETURN (INFO FOR TABLE")) return [true];
      throw new Error(`unexpected workspace query: ${sql}`);
    },
  };
}

describe("LegacyQuotaMigrationConductor", () => {
  test("inventory records mutable legacy counters only as discrepancy evidence", async () => {
    let persistedChecksum = "";
    const store = fakeStore({
      async listWorkspaces() {
        return [workspace];
      },
      async loadPlanRevision(id) {
        return id === plan.id.toString() ? plan : undefined;
      },
      async persistInventory(inventory) {
        persistedChecksum = inventory.checksum;
        return run({ inventoryChecksum: inventory.checksum });
      },
    });
    const conductor = new LegacyQuotaMigrationConductor(
      store,
      async () => workspaceSession(),
      { async refreshWorkspace() { return {}; } },
      { async activate() {} },
      { clock: { now: () => now }, workerId: "test" },
    );

    const inventory = await conductor.createInventory({
      runId: "demo",
      namespace: "main",
      draftAssignments: [assignment],
    });

    expect(inventory.checksum).toBe(persistedChecksum);
    expect(inventory.workspaces[0]?.physical?.totals).toEqual({
      table_count: "2",
      field_count: "3",
      record_count: "4",
    });
    expect(inventory.workspaces[0]?.target?.overage).toEqual([
      {
        resource: "record",
        table: "ent_case",
        used: "3",
        limit: "2",
        over_by: "1",
      },
    ]);
    expect(inventory.workspaces[0]?.anomalies).toContainEqual({
      code: "legacy_record_counter_discrepancy",
      severity: "discrepancy",
      details: {
        sheet: "sheet:case",
        table: "ent_case",
        legacy: "99",
        physical: "3",
      },
    });
  });

  test("approved manifest validates all active mappings before authority writes", async () => {
    const baseRun = run();
    const unsigned = {
      format_version: 1 as const,
      manifest_id: "approved-demo",
      inventory_checksum: baseRun.inventoryChecksum,
      approved_by_subject: "operator:alice",
      approved_at: "2026-07-29T00:00:00.000Z",
      assignments: [assignment],
    };
    const manifest: QuotaMigrationAssignmentManifest = {
      ...unsigned,
      checksum: migrationChecksum(unsigned),
    };
    let assignmentsPersisted = false;
    let authorityApplied = false;
    let refreshed = false;
    const store = fakeStore({
      async findRun() {
        return baseRun;
      },
      async inventoryBlockers() {
        return [];
      },
      async manifestContext() {
        return {
          workspaces: [workspace],
          plans: new Map([[plan.id.toString(), plan]]),
          billingAccounts: new Set(["billing_account:acme"]),
          approverAuthorized: true,
        };
      },
      async persistAssignments(_run, _manifest, cohorts) {
        assignmentsPersisted =
          cohorts.get(workspace.id.toString()) === "synthetic_internal";
      },
      async applyAssignmentAuthority() {
        authorityApplied = true;
      },
    });
    const conductor = new LegacyQuotaMigrationConductor(
      store,
      async () => workspaceSession(),
      {
        async refreshWorkspace() {
          refreshed = true;
          return {};
        },
      },
      { async activate() {} },
      { clock: { now: () => now }, workerId: "test" },
    );

    await conductor.importApprovedManifest("demo", manifest);
    expect(assignmentsPersisted).toBe(true);
    expect(authorityApplied).toBe(true);
    expect(refreshed).toBe(true);
  });

  test("unknown or duplicate mapping is rejected before partial import", async () => {
    const baseRun = run();
    const duplicate = [assignment, { ...assignment }];
    const unsigned = {
      format_version: 1 as const,
      manifest_id: "invalid-demo",
      inventory_checksum: baseRun.inventoryChecksum,
      approved_by_subject: "operator:alice",
      approved_at: "2026-07-29T00:00:00.000Z",
      assignments: duplicate,
    };
    const manifest = {
      ...unsigned,
      checksum: migrationChecksum(unsigned),
    };
    let persisted = false;
    const store = fakeStore({
      async findRun() {
        return baseRun;
      },
      async inventoryBlockers() {
        return [];
      },
      async manifestContext() {
        return {
          workspaces: [workspace],
          plans: new Map([[plan.id.toString(), plan]]),
          billingAccounts: new Set(["billing_account:acme"]),
          approverAuthorized: true,
        };
      },
      async persistAssignments() {
        persisted = true;
      },
    });
    const conductor = new LegacyQuotaMigrationConductor(
      store,
      async () => workspaceSession(),
      { async refreshWorkspace() { return {}; } },
      { async activate() {} },
    );

    await expect(
      conductor.importApprovedManifest("demo", manifest),
    ).rejects.toThrow("more than one approved assignment");
    expect(persisted).toBe(false);
  });

  test("commit readback distinguishes committed, retryable, and unresolved states", () => {
    expect(classifyCommitUnknownReadback({
      nativeMatchesPhysicalScan: true,
      eventTargetCount: 2,
      presentEventCount: 0,
      physicalScanUnchanged: true,
    })).toBe("verified");
    expect(classifyCommitUnknownReadback({
      nativeMatchesPhysicalScan: true,
      eventTargetCount: 2,
      presentEventCount: 2,
      physicalScanUnchanged: true,
    })).toBe("retryable_not_committed");
    expect(classifyCommitUnknownReadback({
      nativeMatchesPhysicalScan: true,
      eventTargetCount: 2,
      presentEventCount: 1,
      physicalScanUnchanged: true,
    })).toBe("blocked_unresolved");
    expect(classifyCommitUnknownReadback({
      nativeMatchesPhysicalScan: false,
      eventTargetCount: 2,
      presentEventCount: 0,
      physicalScanUnchanged: false,
    })).toBe("blocked_unresolved");
  });

  test("a definitely uncommitted workspace prevents cohort observation", async () => {
    let observed = false;
    const baseRun = run({
      state: "ready_to_reopen",
      publicReopenReady: true,
    });
    const operation = {
      id: new StringRecordId("quota_migration_workspace_operation:demo"),
      run: baseRun.id,
      workspace: workspace.id,
      database: workspace.database,
      cohort: "synthetic_internal" as const,
      state: "native_policy_active" as const,
      inventoryEventTargets: ["sheet"],
      attemptCount: 0,
      fencingToken: 0,
    };
    const store = fakeStore({
      async findRun() {
        return baseRun;
      },
      async startCohort() {},
      async listOperations() {
        return [operation];
      },
      async observeCohort() {
        observed = true;
        return now;
      },
    });
    const conductor = new LegacyQuotaMigrationConductor(
      store,
      async () => workspaceSession(),
      { async refreshWorkspace() { return {}; } },
      { async activate() {} },
    );
    Object.assign(conductor, {
      cutoverWorkspace: async () => "retryable_not_committed",
    });

    await expect(
      conductor.cutoverCohort("demo", "synthetic_internal"),
    ).rejects.toThrow("retry the workspace before cohort observation");
    expect(observed).toBe(false);
  });

  test("cleanup eligibility starts thirty days after the later stability gate", async () => {
    let persistedNotBefore: DateTime | undefined;
    const verifiedAt = new DateTime("2026-07-01T00:00:00.000Z");
    const productStableAt = new DateTime("2026-07-05T00:00:00.000Z");
    const store = fakeStore({
      async findRun() {
        return run({
          state: "native_verified",
          allNativeVerifiedAt: verifiedAt,
        });
      },
      async markCleanupEvidence(_run, evidence) {
        persistedNotBefore = evidence.cleanupNotBefore;
      },
    });
    const conductor = new LegacyQuotaMigrationConductor(
      store,
      async () => workspaceSession(),
      { async refreshWorkspace() { return {}; } },
      { async activate() {} },
    );

    const cleanupNotBefore = await conductor.recordCleanupEvidence("demo", {
      fullAuditCleanAt: productStableAt,
      productReleaseStableSince: productStableAt,
      preNativeCompatibilityBlockedAt: productStableAt,
    });

    expect(cleanupNotBefore.toString()).toBe(
      "2026-08-04T00:00:00.000Z",
    );
    expect(persistedNotBefore?.toString()).toBe(cleanupNotBefore.toString());
  });

  test("cleanup evidence rejects cohort observation and future timestamps", async () => {
    const observingStore = fakeStore({
      async findRun() {
        return run({
          state: "observing",
          allNativeVerifiedAt: undefined,
        });
      },
    });
    const observingConductor = new LegacyQuotaMigrationConductor(
      observingStore,
      async () => workspaceSession(),
      { async refreshWorkspace() { return {}; } },
      { async activate() {} },
      { clock: { now: () => now } },
    );
    const evidence = {
      fullAuditCleanAt: now,
      productReleaseStableSince: now,
      preNativeCompatibilityBlockedAt: now,
    };
    await expect(
      observingConductor.recordCleanupEvidence("demo", evidence),
    ).rejects.toThrow("all active workspaces must be native_verified first");

    const verifiedStore = fakeStore({
      async findRun() {
        return run({
          state: "native_verified",
          allNativeVerifiedAt: now,
        });
      },
    });
    const verifiedConductor = new LegacyQuotaMigrationConductor(
      verifiedStore,
      async () => workspaceSession(),
      { async refreshWorkspace() { return {}; } },
      { async activate() {} },
      { clock: { now: () => now } },
    );
    await expect(
      verifiedConductor.recordCleanupEvidence("demo", {
        ...evidence,
        fullAuditCleanAt: new DateTime("2026-07-30T00:00:00.000Z"),
      }),
    ).rejects.toThrow("cannot be in the future");
  });
});
