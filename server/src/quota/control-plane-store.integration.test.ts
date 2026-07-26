import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, StringRecordId, Surreal } from "surrealdb";
import { SurrealQuotaControlPlaneStore } from "./control-plane-store";

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
    "memory",
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
      rules: [{
        rule_key: "records",
        resource: "record",
        selector: { kind: "regex", value: "^ent_" },
        limit: { kind: "finite", value: 100 },
        customer_label: "记录数"
      }],
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
  `);
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
});
