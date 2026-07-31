import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Surreal } from "surrealdb";
import { SurrealNativeQuotaClient } from "../db/native-quota/client";
import { commercialProductRules } from "../db/quota-plan-rules";
import { SurrealQuotaControlPlaneStore } from "./control-plane-store";
import { SurrealEntitlementRefreshService } from "./entitlement-refresh";
import { QuotaReconciler } from "./reconciler";
import { MaterializationWorker } from "./sweeps";
import {
  DurableQuotaMigrationPolicyActivator,
  LegacyQuotaMigrationConductor,
} from "../quota-migration/conductor";
import { SurrealQuotaMigrationStore } from "../quota-migration/store";
import {
  assignMigrationCohorts,
  migrationChecksum,
  physicalScanChecksum,
} from "../quota-migration/model";
import type {
  QuotaMigrationAssignmentManifest,
  QuotaMigrationInventory,
} from "@surreal-ck/shared/native-quota";

const RUN_INTEGRATION =
  process.env.RUN_LOCAL_SURREALDB_CONTROL_PLANE_TESTS === "1";
const localTest = test.skipIf(!RUN_INTEGRATION);
const surrealBinary = process.env.SURREAL_BINARY ?? "surreal";
const namespace = "main";
const database = "_system";
const migrationsUrl = new URL(
  "../../../shared/sql/system/",
  import.meta.url,
);

let endpoint = "";
let workingDirectory = "";
let server: ReturnType<typeof Bun.spawn> | undefined;
let db: Surreal | undefined;

async function allocatePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close();
        reject(new Error("failed to allocate SurrealDB port"));
        return;
      }
      listener.close((error) =>
        error ? reject(error) : resolve(address.port)
      );
    });
  });
}

async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const probe = Bun.spawn([
      surrealBinary,
      "is-ready",
      "--endpoint",
      endpoint,
    ], { stdout: "ignore", stderr: "ignore" });
    if (await probe.exited === 0) return;
    await Bun.sleep(100);
  }
  throw new Error("local SurrealDB did not become ready");
}

beforeAll(async () => {
  if (!RUN_INTEGRATION) return;
  workingDirectory = await mkdtemp(
    join(tmpdir(), "surreal-ck-quota-control-plane-"),
  );
  const port = await allocatePort();
  endpoint = `ws://127.0.0.1:${port}`;
  server = Bun.spawn([
    surrealBinary,
    "start",
    "--no-banner",
    "--log",
    "none",
    "--bind",
    `127.0.0.1:${port}`,
    "--user",
    "root",
    "--pass",
    "root",
    `rocksdb:${join(workingDirectory, "data")}`,
  ], {
    cwd: workingDirectory,
    stdout: "ignore",
    stderr: "pipe",
  });
  await waitUntilReady();

  db = new Surreal();
  await db.connect(`${endpoint}/rpc`, {
    authentication: { username: "root", password: "root" },
  });
  await db.query(`DEFINE NAMESPACE IF NOT EXISTS ${namespace};`);
  await db.use({ namespace });
  await db.query(`DEFINE DATABASE IF NOT EXISTS ${database};`);
  await db.use({ namespace, database });
  const migrations = (await readdir(migrationsUrl))
    .filter((entry) => /^\d{3}-.+\.surql$/u.test(entry))
    .sort();
  for (const migration of migrations) {
    await db.query(await readFile(new URL(migration, migrationsUrl), "utf8"));
  }
  await db.query(`
    CREATE workspace:acme CONTENT {
      db_name: "ws_acme",
      owner_subject: "owner-acme",
      slug: "acme",
      name: "Acme",
      status: "active"
    };
    CREATE quota_plan:plus CONTENT {
      plan_key: "plus",
      display_name: "Plus",
      visibility: "public",
      status: "active"
    };
    CREATE quota_plan_revision:plus_v1 CONTENT {
      plan: quota_plan:plus,
      revision: 1,
      template_kind: "commercial",
      rules: $seededRules,
      created_by_subject: "operator:test",
      published_at: time::now(),
      correlation_id: "corr-plan"
    };
    CREATE resource_entitlement:acme_v1 CONTENT {
      workspace: workspace:acme,
      revision: 1,
      source_type: "manual",
      plan_revision: quota_plan_revision:plus_v1,
      service_mode: "standard",
      rules: [{
        rule_key: "records",
        resource: "record",
        selector: { kind: "regex", value: "^ent_" },
        limit: { kind: "finite", value: 100 },
        customer_label: "记录数"
      }],
      source_digest: "source-v1",
      effective_at: time::now(),
      correlation_id: "corr-entitlement"
    };
    CREATE quota_policy_projection:acme_v1 CONTENT {
      workspace: workspace:acme,
      entitlement: resource_entitlement:acme_v1,
      revision: 1,
      compiler_version: "quota-policy-compiler-v1",
      native_capability: "native-quota-v1",
      native_contract_major: 1,
      info_format_version: 1,
      rules: [{
        rule_id: "records",
        resource: "record",
        selector: { kind: "regex", pattern: "^ent_" },
        limit: { kind: "finite", value: 100 }
      }],
      rule_labels: [{
        rule_id: "records",
        rule_key: "records",
        resource: "record",
        customer_label: "记录数"
      }],
      canonical_digest: "projection-v1",
      correlation_id: "corr-projection"
    };
    UPDATE workspace:acme SET
      desired_entitlement = resource_entitlement:acme_v1,
      desired_quota_projection = quota_policy_projection:acme_v1;
    CREATE workspace_quota_runtime:acme CONTENT {
      workspace: workspace:acme,
      sync_state: "pending",
      service_mode: "standard",
      quota_compliance: "unknown",
      capacity_state: "unknown",
      auto_reconcile: true,
      usage_trusted: false,
      fencing_token: 0
    };
    CREATE quota_materialization_operation:acme_v1 CONTENT {
      workspace: workspace:acme,
      entitlement: resource_entitlement:acme_v1,
      projection: quota_policy_projection:acme_v1,
      status: "pending",
      idempotency_key: "materialize-acme-v1",
      correlation_id: "corr-materialize"
    };
  `, {
    seededRules: commercialProductRules({
      tables: 1,
      fields: 3,
      records: 2,
    }),
  });
  await db.query("DEFINE DATABASE IF NOT EXISTS ws_acme;");

  const workspaceDb = new Surreal();
  await workspaceDb.connect(`${endpoint}/rpc`, {
    authentication: { username: "root", password: "root" },
    namespace,
    database: "ws_acme",
  });
  await workspaceDb.query(`
    DEFINE TABLE resource_quota_plan SCHEMALESS;
    DEFINE TABLE workspace_resource_quota SCHEMALESS;
    DEFINE TABLE sheet_resource_usage SCHEMALESS;
    DEFINE TABLE sheet SCHEMAFULL;
    DEFINE FIELD table_name ON TABLE sheet TYPE string;
    DEFINE TABLE ent_case SCHEMALESS;
    DEFINE TABLE legacy_quota_event SCHEMALESS;
    CREATE resource_quota_plan:plus SET
      key = "plus",
      max_sheets = 1,
      max_fields_per_sheet = 3,
      max_records_per_sheet = 100;
    CREATE workspace_resource_quota:current SET
      plan = resource_quota_plan:plus,
      sheet_count = 1;
    CREATE sheet:case SET table_name = "ent_case";
    CREATE sheet_resource_usage:case SET
      sheet = sheet:case,
      record_count = 99;
    CREATE ent_case:one SET value = 1;
    DEFINE EVENT resource_quota_guard ON TABLE sheet
      WHEN $event = "CREATE"
      THEN (CREATE legacy_quota_event SET source = $after.id);
    DEFINE EVENT resource_quota_guard ON TABLE ent_case
      WHEN $event = "CREATE"
      THEN (CREATE legacy_quota_event SET source = $after.id);
  `);
  await workspaceDb.close();
});

afterAll(async () => {
  await db?.close();
  server?.kill();
  if (server) await server.exited;
  if (workingDirectory) {
    await rm(workingDirectory, { force: true, recursive: true });
  }
});

function queryClient() {
  if (!db) throw new Error("integration database not initialized");
  return {
    query: async <T = unknown>(
      sql: string,
      params?: Record<string, unknown>,
    ): Promise<T> => await db!.query(sql, params) as T,
  };
}

describe("SurrealQuotaControlPlaneStore against local SurrealDB", () => {
  localTest(
    "fences concurrent materializers, survives takeover, and persists sweep cursor/backoff",
    async () => {
      const firstStore = new SurrealQuotaControlPlaneStore(queryClient());
      const secondStore = new SurrealQuotaControlPlaneStore(queryClient());
      const startedAt = DateTime.now();
      const [first, second] = await Promise.all([
        firstStore.claimNextMaterialization({
          workerId: "bun-a",
          now: startedAt,
          leaseDurationMs: 1_000,
        }),
        secondStore.claimNextMaterialization({
          workerId: "bun-b",
          now: startedAt,
          leaseDurationMs: 1_000,
        }),
      ]);
      const winner = first ?? second;
      expect(winner).toBeDefined();
      expect([first, second].filter(Boolean)).toHaveLength(1);
      if (!winner) throw new Error("expected materialization lease");

      const takeoverAt = DateTime.fromEpochNanoseconds(
        startedAt.nanoseconds + 1_001_000_000n,
      );
      const takeover = await secondStore.claimNextMaterialization({
        workerId: "bun-c",
        now: takeoverAt,
        leaseDurationMs: 1_000,
      });
      expect(takeover?.fencingToken).toBe(2);
      if (!takeover) throw new Error("expected materialization takeover");

      await expect(firstStore.settleMaterialization(winner, {
        kind: "superseded",
        outcome: "superseded",
        completedAt: takeoverAt,
      })).resolves.toBe("lease_lost");
      await expect(secondStore.settleMaterialization(takeover, {
        kind: "superseded",
        outcome: "superseded",
        completedAt: takeoverAt,
      })).resolves.toBe("committed");

      const operation = await db!.query<unknown[]>(
        "SELECT status, fencing_token FROM ONLY quota_materialization_operation:acme_v1;",
      );
      expect(JSON.stringify(operation)).toContain('"status":"superseded"');
      expect(JSON.stringify(operation)).toContain('"fencing_token":2');

      const sweepA = await firstStore.claimSweep({
        name: "native_audit_sweep",
        workerId: "bun-a",
        now: startedAt,
        leaseDurationMs: 1_000,
      });
      const sweepB = await secondStore.claimSweep({
        name: "native_audit_sweep",
        workerId: "bun-b",
        now: startedAt,
        leaseDurationMs: 1_000,
      });
      expect(sweepA).toBeDefined();
      expect(sweepB).toBeUndefined();
      if (!sweepA) throw new Error("expected sweep lease");
      await expect(firstStore.failSweep(sweepA, {
        errorCode: "temporary",
        errorRetryable: true,
        errorDetails: { source: "integration" },
        nextAttemptAt: takeoverAt,
        failedAt: startedAt,
      })).resolves.toBeTrue();
      await expect(secondStore.claimSweep({
        name: "native_audit_sweep",
        workerId: "bun-b",
        now: startedAt,
        leaseDurationMs: 1_000,
      })).resolves.toBeUndefined();
      const resumed = await secondStore.claimSweep({
        name: "native_audit_sweep",
        workerId: "bun-b",
        now: takeoverAt,
        leaseDurationMs: 1_000,
      });
      expect(resumed?.attemptNumber).toBe(2);
      if (!resumed) throw new Error("expected resumed sweep");
      await expect(secondStore.checkpointSweep(resumed, {
        cursor: "workspace:acme",
        completed: false,
        processed: 1,
        failed: 0,
        completedAt: takeoverAt,
      })).resolves.toBeTrue();
      const cursor = await db!.query<unknown[]>(
        'SELECT cursor, attempt_count FROM ONLY quota_sweep_cursor WHERE sweep_name = "native_audit_sweep";',
      );
      expect(JSON.stringify(cursor)).toContain('"cursor":"workspace:acme"');
      expect(JSON.stringify(cursor)).toContain('"attempt_count":0');
    },
    30_000,
  );

  localTest(
    "persists immutable migration inventory/assignments and pauses on blocking signals",
    async () => {
      if (!db) throw new Error("integration database not initialized");
      await db.query(`
        CREATE billing_account:acme CONTENT {
          account_key: "acme",
          name: "Acme",
          kind: "team",
          status: "active"
        };
        CREATE platform_operator:migration CONTENT {
          subject: "operator:migration",
          status: "active"
        };
        CREATE platform_operator_capability:migration_subscription CONTENT {
          operator: platform_operator:migration,
          capability: "subscription.manage",
          status: "active",
          granted_by_subject: "root"
        };
      `);
      const physicalTables = [{
        table: "sheet",
        field_count: "1",
        record_count: "0",
      }];
      const workspaceUnsigned = {
        workspace_id: "workspace:acme",
        workspace_slug: "acme",
        database: "ws_acme",
        workspace_status: "active" as const,
        legacy: null,
        physical: {
          tables: physicalTables,
          totals: {
            table_count: "1",
            field_count: "1",
            record_count: "0",
          },
          scan_checksum: physicalScanChecksum(physicalTables),
        },
        target: null,
        anomalies: [],
      };
      const workspaceInventory = {
        ...workspaceUnsigned,
        checksum: migrationChecksum(workspaceUnsigned),
      };
      const inventoryUnsigned = {
        format_version: 1 as const,
        run_id: "integration",
        namespace,
        generated_at: "2026-07-29T00:00:00.000Z",
        workspaces: [workspaceInventory],
      };
      const inventory: QuotaMigrationInventory = {
        ...inventoryUnsigned,
        checksum: migrationChecksum(inventoryUnsigned),
      };
      const store = new SurrealQuotaMigrationStore(queryClient());
      const run = await store.persistInventory(inventory);
      expect(run.state).toBe("inventory_ready");
      expect(await store.inventoryBlockers(run.id)).toEqual([]);

      const assignment = {
        workspace_id: "workspace:acme",
        workspace_slug: "acme",
        database: "ws_acme",
        billing_account_id: "billing_account:acme",
        plan_revision_id: "quota_plan_revision:plus_v1",
        source: "manual" as const,
        effective_at: "2026-07-29T00:00:00.000Z",
        rollout_class: "internal" as const,
        evidence_reference: "integration-evidence",
      };
      const manifestUnsigned = {
        format_version: 1 as const,
        manifest_id: "integration-approved",
        inventory_checksum: inventory.checksum,
        approved_by_subject: "operator:migration",
        approved_at: "2026-07-29T00:00:00.000Z",
        assignments: [assignment],
      };
      const manifest: QuotaMigrationAssignmentManifest = {
        ...manifestUnsigned,
        checksum: migrationChecksum(manifestUnsigned),
      };
      const context = await store.manifestContext(manifest);
      expect(context.approverAuthorized).toBe(true);
      expect(context.billingAccounts.has("billing_account:acme")).toBe(true);
      expect(context.plans.has("quota_plan_revision:plus_v1")).toBe(true);

      await store.persistAssignments(
        run,
        manifest,
        assignMigrationCohorts(manifest.assignments),
      );
      await store.applyAssignmentAuthority(
        run,
        manifest,
        "workspace:acme",
      );
      const snapshot = JSON.stringify(await db.query(`
        SELECT count() AS assignments
          FROM quota_migration_assignment GROUP ALL;
        SELECT count() AS cohorts
          FROM quota_migration_cohort GROUP ALL;
        SELECT status, workspace, plan_revision
          FROM quota_subscription_item
          WHERE active_workspace = workspace:acme;
      `));
      expect(snapshot).toContain('"assignments":1');
      expect(snapshot).toContain('"cohorts":5');
      expect(snapshot).toContain('"status":"active"');
      expect(snapshot).toContain('"plan_revision":"quota_plan_revision:plus_v1"');

      await store.recordSignal(run, "synthetic_internal", {
        kind: "counter_mismatch",
        workspace_id: "workspace:acme",
        details: { source: "integration" },
        observed_at: "2026-07-29T00:01:00.000Z",
      });
      expect((await store.findRun("integration"))?.state).toBe("paused");

      const cleanupAt = new DateTime("2026-09-01T00:00:00.000Z");
      await db.query(
        `
          UPDATE $run SET
            state = "observing",
            all_native_verified_at = d"2026-07-29T00:00:00.000Z",
            full_audit_clean_at = d"2026-07-30T00:00:00.000Z",
            product_release_stable_since = d"2026-07-29T00:00:00.000Z",
            pre_native_compatibility_blocked_at =
              d"2026-09-02T00:00:00.000Z",
            cleanup_not_before = d"2026-08-28T00:00:00.000Z";
          UPDATE quota_migration_workspace_operation
            SET state = "native_verified"
            WHERE run = $run;
        `,
        { run: run.id },
      );
      await expect(
        store.markCleanupEligible(run, cleanupAt),
      ).rejects.toThrow();
      await db.query(
        `
          UPDATE $run SET
            pre_native_compatibility_blocked_at =
              d"2026-08-31T00:00:00.000Z";
        `,
        { run: run.id },
      );
      await store.markCleanupEligible(run, cleanupAt);
      expect((await store.findRun("integration"))?.state).toBe(
        "cleanup_eligible",
      );
    },
    60_000,
  );

  localTest(
    "runs the durable migration conductor through native policy cutover and cleanup eligibility",
    async () => {
      if (!db) throw new Error("integration database not initialized");
      await db.query(`
        INSERT INTO billing_account {
          id: billing_account:acme,
          account_key: "acme",
          name: "Acme",
          kind: "team",
          status: "active"
        }
        ON DUPLICATE KEY UPDATE name = $input.name, status = "active";
        INSERT INTO platform_operator {
          id: platform_operator:migration,
          subject: "operator:migration",
          status: "active"
        }
        ON DUPLICATE KEY UPDATE status = "active";
        INSERT INTO platform_operator_capability {
          id: platform_operator_capability:migration_subscription,
          operator: platform_operator:migration,
          capability: "subscription.manage",
          status: "active",
          granted_by_subject: "root"
        }
        ON DUPLICATE KEY UPDATE status = "active";
        UPDATE workspace:acme SET
          desired_entitlement = NONE,
          applied_entitlement = NONE,
          desired_quota_projection = NONE,
          applied_quota_projection = NONE;
        UPDATE workspace_quota_runtime SET
          sync_state = "pending",
          service_mode = "retention",
          usage_trusted = false
        WHERE workspace = workspace:acme;
      `);

      const sessions = new Map<string, Surreal>();
      const sessionFor = async (targetDatabase: string) => {
        const existing = sessions.get(targetDatabase);
        if (existing) return existing;
        const session = new Surreal();
        await session.connect(`${endpoint}/rpc`, {
          authentication: { username: "root", password: "root" },
          namespace,
          database: targetDatabase,
        });
        sessions.set(targetDatabase, session);
        return session;
      };

      try {
        const systemClient = queryClient();
        const migrationStore = new SurrealQuotaMigrationStore(systemClient);
        const refresher = new SurrealEntitlementRefreshService(systemClient);
        const controlStore = new SurrealQuotaControlPlaneStore(systemClient);
        const nativeQuota = new SurrealNativeQuotaClient(systemClient);
        let now = new DateTime("2026-07-29T00:02:00.000Z");
        const reconciler = new QuotaReconciler(controlStore, nativeQuota, {
          clock: { now: () => now },
          random: () => 0,
        });
        const worker = new MaterializationWorker(
          controlStore,
          reconciler,
          "migration-materializer",
          { clock: { now: () => now } },
        );
        const activator = new DurableQuotaMigrationPolicyActivator(
          migrationStore,
          worker,
        );
        const makeConductor = () =>
          new LegacyQuotaMigrationConductor(
            migrationStore,
            sessionFor,
            refresher,
            activator,
            {
              clock: { now: () => now },
              workerId: "migration-conductor",
            },
          );
        let conductor = makeConductor();
        const assignment = {
          workspace_id: "workspace:acme",
          workspace_slug: "acme",
          database: "ws_acme",
          billing_account_id: "billing_account:acme",
          plan_revision_id: "quota_plan_revision:plus_v1",
          source: "manual" as const,
          effective_at: now.toString(),
          rollout_class: "internal" as const,
          evidence_reference: "integration-approved",
        };
        const inventory = await conductor.createInventory({
          runId: "conductor-e2e",
          namespace,
          draftAssignments: [assignment],
        });
        expect(inventory.workspaces).toHaveLength(1);
        expect(inventory.workspaces[0]?.legacy?.event_targets).toEqual(
          expect.arrayContaining([
            { table: "sheet", event_present: true },
            { table: "ent_case", event_present: true },
          ]),
        );

        const manifestUnsigned = {
          format_version: 1 as const,
          manifest_id: "conductor-e2e-approved",
          inventory_checksum: inventory.checksum,
          approved_by_subject: "operator:migration",
          approved_at: now.toString(),
          assignments: [assignment],
        };
        const manifest: QuotaMigrationAssignmentManifest = {
          ...manifestUnsigned,
          checksum: migrationChecksum(manifestUnsigned),
        };
        try {
          await conductor.importApprovedManifest("conductor-e2e", manifest);
        } catch (cause) {
          throw new Error("manifest import failed", { cause });
        }
        try {
          await conductor.prepareNativeEnforcement("conductor-e2e", {
            snapshot_id: "snapshot-conductor-e2e",
            snapshot_checksum: `sha256:${"1".repeat(64)}`,
            restore_drill_completed_at: now.toString(),
            fork_release: "3.3.0-native-quota.1",
            fork_image_digest: `sha256:${"2".repeat(64)}`,
            compatibility_manifest_revision: "native-quota-v1.0",
            backend: "rocksdb",
            backend_certification_revision: "native-quota-contract-v1",
            format_migration_completed_at: now.toString(),
          });
        } catch (cause) {
          throw new Error(
            `native enforcement preparation failed: ${
              JSON.stringify(cause)
            }`,
            { cause },
          );
        }
        await expect(
          conductor.assertPublicReopenReady("conductor-e2e"),
        ).resolves.toBeUndefined();

        await conductor.pause("conductor-e2e", "operator-drill");
        expect((await migrationStore.findRun("conductor-e2e"))?.state).toBe(
          "paused",
        );
        await conductor.resume("conductor-e2e");

        // Recreate the conductor at the persisted phase boundary to prove that
        // no in-memory state is required for cutover.
        conductor = makeConductor();
        const cohorts = [
          "synthetic_internal",
          "one_percent",
          "ten_percent",
          "fifty_percent",
          "remainder",
        ] as const;
        for (const cohort of cohorts) {
          const observeUntil = await conductor.cutoverCohort(
            "conductor-e2e",
            cohort,
          );
          now = observeUntil;
          await conductor.completeCohort("conductor-e2e", cohort);
        }

        const nativeInfo = await nativeQuota.info("ws_acme");
        expect(nativeInfo.policy?.rules).toHaveLength(8);
        expect(nativeInfo.policy?.rules).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              resource: "record",
              selector: { kind: "regex", pattern: "^ent_" },
              limit: { kind: "finite", value: 2 },
            }),
          ]),
        );
        expect(nativeInfo.ledger).toMatchObject({
          state: "ready",
          usage_trusted: true,
        });
        const workspaceSession = await sessionFor("ws_acme");
        const eventReadback = await workspaceSession.query(`
          RETURN (INFO FOR TABLE sheet).events.resource_quota_guard != NONE;
          RETURN (INFO FOR TABLE ent_case).events.resource_quota_guard != NONE;
        `);
        expect(eventReadback).toEqual([false, false]);

        const verifiedRun = await migrationStore.findRun("conductor-e2e");
        expect(verifiedRun?.state).toBe("native_verified");
        if (!verifiedRun?.allNativeVerifiedAt) {
          throw new Error("expected native verification timestamp");
        }
        now = DateTime.fromEpochNanoseconds(
          verifiedRun.allNativeVerifiedAt.nanoseconds
            + 31n * 24n * 60n * 60n * 1_000_000_000n,
        );
        const cleanupNotBefore = await conductor.recordCleanupEvidence(
          "conductor-e2e",
          {
            fullAuditCleanAt: verifiedRun.allNativeVerifiedAt,
            productReleaseStableSince: verifiedRun.allNativeVerifiedAt,
            preNativeCompatibilityBlockedAt: verifiedRun.allNativeVerifiedAt,
          },
        );
        expect(cleanupNotBefore.nanoseconds).toBeLessThanOrEqual(now.nanoseconds);
        await conductor.markCleanupEligible("conductor-e2e");
        expect((await migrationStore.findRun("conductor-e2e"))?.state).toBe(
          "cleanup_eligible",
        );
      } finally {
        await Promise.all(
          [...sessions.values()].map(async (session) => await session.close()),
        );
      }
    },
    120_000,
  );
});
