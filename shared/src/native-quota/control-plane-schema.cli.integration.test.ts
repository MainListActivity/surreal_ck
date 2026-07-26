import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Surreal } from "surrealdb";

const RUN_SYSTEM_SCHEMA_TESTS =
  process.env.RUN_LOCAL_SURREALDB_SYSTEM_SCHEMA_TESTS === "1";
const localSurrealTest = test.skipIf(!RUN_SYSTEM_SCHEMA_TESTS);
const surrealBinary = process.env.SURREAL_BINARY ?? "surreal";
const namespace = "main";
const database = "_system";
const rootUsername = "root";
const rootPassword = "root";
const migrationsDirectoryUrl = new URL("../../sql/system/", import.meta.url);

let endpoint = process.env.LOCAL_SURREAL_URL ?? "";
let surrealServer: ReturnType<typeof Bun.spawn> | null = null;
let cliWorkingDirectory = "";
let recordSession: Surreal | null = null;

type CliCredentials = {
  username: string;
  password: string;
};

async function allocatePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate local SurrealDB port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ready = Bun.spawn([surrealBinary, "is-ready", "--endpoint", endpoint], {
      cwd: cliWorkingDirectory,
      stdout: "ignore",
      stderr: "ignore",
    });
    if (await ready.exited === 0) return;
    await Bun.sleep(100);
  }
  throw new Error(`local SurrealDB did not become ready: ${endpoint}`);
}

beforeAll(async () => {
  if (!RUN_SYSTEM_SCHEMA_TESTS) return;
  cliWorkingDirectory = await mkdtemp(join(tmpdir(), "surreal-ck-system-schema-"));
  if (endpoint) return;

  const port = await allocatePort();
  endpoint = `ws://127.0.0.1:${port}`;
  surrealServer = Bun.spawn([
    surrealBinary,
    "start",
    "--no-banner",
    "--log",
    "none",
    "--bind",
    `127.0.0.1:${port}`,
    "--user",
    rootUsername,
    "--pass",
    rootPassword,
    "memory",
  ], {
    cwd: cliWorkingDirectory,
    stdout: "ignore",
    stderr: "pipe",
  });
  await waitUntilReady();
});

afterAll(async () => {
  await recordSession?.close();
  surrealServer?.kill();
  if (surrealServer) await surrealServer.exited;
  if (cliWorkingDirectory) {
    await rm(cliWorkingDirectory, { force: true, recursive: true });
  }
});

function oneLineSurql(sql: string): string {
  return sql
    .replace(/^\s*--.*$/gmu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

async function runSurrealCli(
  sql: string,
  credentials: CliCredentials = {
    username: rootUsername,
    password: rootPassword,
  },
): Promise<string> {
  const args = [
    surrealBinary,
    "sql",
    "--json",
    "--hide-welcome",
    "--endpoint",
    endpoint,
    "--username",
    credentials.username,
    "--password",
    credentials.password,
    "--namespace",
    namespace,
    "--database",
    database,
  ];
  const child = Bun.spawn(args, {
    cwd: cliWorkingDirectory,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(`${oneLineSurql(sql)}\n`);
  child.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`surreal sql failed (${exitCode}): ${stderr || stdout}`);
  }
  return `${stdout}\n${stderr}`;
}

function expectSuccessful(output: string): void {
  expect(output).not.toMatch(
    /"status"\s*:\s*"ERR"|Parse error|There was a problem|An error occurred|Error while processing event/iu,
  );
}

async function readMigrations(): Promise<string[]> {
  const entries = (await readdir(migrationsDirectoryUrl))
    .filter((entry) => /^\d{3}-.+\.surql$/u.test(entry))
    .sort();
  return await Promise.all(
    entries.map(async (entry) => await readFile(new URL(entry, migrationsDirectoryUrl), "utf8")),
  );
}

const productRule = `{
  rule_key: "records-ent",
  resource: "record",
  selector: { kind: "regex", value: "^ent.*$" },
  limit: { kind: "finite", value: 100 },
  customer_label: "实体记录",
  customer_description: "ent 开头的表最多 100 条记录"
}`;

const compiledRule = `{
  rule_id: "rule-records-ent",
  resource: "record",
  selector: { kind: "regex", pattern: "^ent.*$" },
  limit: { kind: "finite", value: 100 }
}`;

describe("_system native quota schema against local SurrealDB", () => {
  localSurrealTest(
    "upgrades existing data, enforces authority invariants, denies database users, and reruns safely",
    async () => {
      const migrations = await readMigrations();
      expect(migrations).toHaveLength(7);

      for (const sql of migrations.slice(0, 3)) {
        expectSuccessful(await runSurrealCli(sql));
      }
      expectSuccessful(await runSurrealCli(`
        CREATE workspace:existing CONTENT {
          db_name: "ws_existing",
          owner_subject: "owner-existing",
          slug: "existing",
          name: "Existing workspace",
          status: "active"
        };
      `));

      for (const sql of migrations.slice(3)) {
        expectSuccessful(await runSurrealCli(sql));
      }
      const existingWorkspace = await runSurrealCli(
        "SELECT id, status FROM ONLY workspace:existing;",
      );
      expect(existingWorkspace).toContain("workspace:existing");
      expect(existingWorkspace).toContain('"status":"active"');

      expectSuccessful(await runSurrealCli(`
        CREATE billing_account:acme CONTENT {
          account_key: "acme",
          name: "Acme",
          kind: "team",
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
          rules: [${productRule}],
          created_by_subject: "operator:test",
          published_at: time::now(),
          correlation_id: "corr-plan-v1"
        };
        CREATE quota_subscription:acme_primary CONTENT {
          billing_account: billing_account:acme,
          source: "manual",
          status: "active",
          revision: 1,
          correlation_id: "corr-subscription"
        };
        CREATE quota_subscription_item:active_primary CONTENT {
          subscription: quota_subscription:acme_primary,
          workspace: workspace:existing,
          plan_revision: quota_plan_revision:plus_v1,
          revision: 1,
          status: "active",
          effective_from: time::now(),
          correlation_id: "corr-item-primary"
        };
      `));

      const duplicatePlanRevision = await runSurrealCli(`
        CREATE quota_plan_revision:plus_v1_duplicate CONTENT {
          plan: quota_plan:plus,
          revision: 1,
          template_kind: "commercial",
          rules: [${productRule}],
          created_by_subject: "operator:test",
          published_at: time::now(),
          correlation_id: "corr-plan-duplicate"
        };
      `);
      expect(duplicatePlanRevision).toMatch(/quota_plan_revision_unique|already contains/iu);

      const duplicateActiveItem = await runSurrealCli(`
        CREATE quota_subscription_item:active_duplicate CONTENT {
          subscription: quota_subscription:acme_primary,
          workspace: workspace:existing,
          plan_revision: quota_plan_revision:plus_v1,
          revision: 2,
          status: "active",
          effective_from: time::now(),
          correlation_id: "corr-item-duplicate"
        };
      `);
      expect(duplicateActiveItem).toMatch(
        /quota_subscription_item_active_workspace_unique|already contains/iu,
      );
      expectSuccessful(await runSurrealCli(`
        CREATE quota_subscription_item:scheduled CONTENT {
          subscription: quota_subscription:acme_primary,
          workspace: workspace:existing,
          plan_revision: quota_plan_revision:plus_v1,
          revision: 2,
          status: "scheduled",
          effective_from: time::now(),
          correlation_id: "corr-item-scheduled"
        };
      `));

      expectSuccessful(await runSurrealCli(`
        CREATE quota_override_revision:existing_v1 CONTENT {
          workspace: workspace:existing,
          revision: 1,
          patches: [{
            rule_key: "records-ent",
            action: "replace",
            limit: { kind: "finite", value: 200 }
          }],
          customer_reason: "temporary expansion",
          operator_reason: "approved support request",
          created_by_subject: "operator:test",
          authorized_capability: "quota.override.write",
          effective_at: time::now(),
          request_id: "request-override-v1",
          correlation_id: "corr-override-v1"
        };
        CREATE workspace_quota_override:existing CONTENT {
          workspace: workspace:existing,
          active_revision: quota_override_revision:existing_v1
        };
      `));
      const duplicateOverride = await runSurrealCli(`
        CREATE workspace_quota_override:existing_duplicate CONTENT {
          workspace: workspace:existing,
          active_revision: quota_override_revision:existing_v1
        };
      `);
      expect(duplicateOverride).toMatch(
        /workspace_quota_override_workspace_unique|already contains/iu,
      );

      const immutableRevision = await runSurrealCli(
        'UPDATE quota_plan_revision:plus_v1 SET correlation_id = "mutated";',
      );
      expect(immutableRevision).toContain(
        "immutable-control-plane-record:quota_plan_revision",
      );
      const unchangedRevision = await runSurrealCli(
        "SELECT correlation_id FROM ONLY quota_plan_revision:plus_v1;",
      );
      expect(unchangedRevision).toContain('"correlation_id":"corr-plan-v1"');

      expectSuccessful(await runSurrealCli(`
        CREATE resource_entitlement:existing_v1 CONTENT {
          workspace: workspace:existing,
          revision: 1,
          source_type: "manual",
          subscription_item: quota_subscription_item:active_primary,
          plan_revision: quota_plan_revision:plus_v1,
          override_revision: quota_override_revision:existing_v1,
          service_mode: "standard",
          rules: [${productRule}],
          source_digest: "source-digest-v1",
          effective_at: time::now(),
          correlation_id: "corr-entitlement-v1",
          causation_id: "request-override-v1"
        };
        CREATE quota_policy_projection:existing_v1 CONTENT {
          workspace: workspace:existing,
          entitlement: resource_entitlement:existing_v1,
          revision: 1,
          compiler_version: "1.0.0",
          native_capability: "native-resource-quota-v1",
          native_contract_major: 1,
          info_format_version: 1,
          rules: [${compiledRule}],
          rule_labels: [{
            rule_id: "rule-records-ent",
            rule_key: "records-ent",
            resource: "record",
            customer_label: "实体记录",
            customer_description: "ent 开头的表最多 100 条记录"
          }],
          canonical_digest: "projection-digest-v1",
          correlation_id: "corr-entitlement-v1",
          causation_id: "resource_entitlement:existing_v1"
        };
        CREATE entitlement_operation:resolve_v1 CONTENT {
          workspace: workspace:existing,
          operation_kind: "manual_assignment",
          outcome: "succeeded",
          entitlement: resource_entitlement:existing_v1,
          projection: quota_policy_projection:existing_v1,
          idempotency_key: "entitlement-resolve-v1",
          request_id: "request-entitlement-v1",
          actor_kind: "operator",
          actor_subject: "operator:test",
          authorized_capability: "quota.subscription.write",
          reason: "manual plan assignment",
          effective_at: time::now(),
          correlation_id: "corr-entitlement-v1",
          causation_id: "request-override-v1"
        };
        CREATE quota_materialization_operation:apply_v1 CONTENT {
          workspace: workspace:existing,
          entitlement: resource_entitlement:existing_v1,
          projection: quota_policy_projection:existing_v1,
          status: "pending",
          idempotency_key: "materialize-v1",
          request_id: "request-materialize-v1",
          correlation_id: "corr-entitlement-v1",
          causation_id: "entitlement_operation:resolve_v1"
        };
        CREATE quota_materialization_attempt:apply_v1_a1 CONTENT {
          operation: quota_materialization_operation:apply_v1,
          attempt_number: 1,
          fencing_token: 1,
          worker_id: "worker-test",
          outcome: "succeeded",
          observed_after_generation: 1,
          observed_after_digest: "projection-digest-v1",
          ledger_state: "ready",
          usage_trusted: true,
          started_at: time::now(),
          completed_at: time::now(),
          duration_ms: 1,
          correlation_id: "corr-entitlement-v1",
          causation_id: "quota_materialization_operation:apply_v1"
        };
        CREATE quota_audit_event:apply_v1 CONTENT {
          event_kind: "quota.materialization.succeeded",
          workspace: workspace:existing,
          entitlement_operation: entitlement_operation:resolve_v1,
          materialization_operation: quota_materialization_operation:apply_v1,
          materialization_attempt: quota_materialization_attempt:apply_v1_a1,
          actor_kind: "system",
          before_reference: "quota_policy_projection:none",
          after_reference: "quota_policy_projection:existing_v1",
          correlation_id: "corr-entitlement-v1",
          causation_id: "quota_materialization_attempt:apply_v1_a1"
        };
      `));
      const causation = await runSurrealCli(`
        SELECT causation_id FROM ONLY entitlement_operation:resolve_v1;
        SELECT causation_id FROM ONLY quota_materialization_attempt:apply_v1_a1;
        SELECT causation_id FROM ONLY quota_audit_event:apply_v1;
      `);
      expect(causation).toContain("request-override-v1");
      expect(causation).toContain("quota_materialization_operation:apply_v1");
      expect(causation).toContain("quota_materialization_attempt:apply_v1_a1");

      expectSuccessful(await runSurrealCli(`
        DEFINE TABLE quota_test_identity SCHEMAFULL PERMISSIONS FULL;
        DEFINE FIELD username ON TABLE quota_test_identity TYPE string;
        DEFINE FIELD password ON TABLE quota_test_identity TYPE string;
        DEFINE ACCESS quota_test_record ON DATABASE TYPE RECORD
          SIGNIN (
            SELECT * FROM quota_test_identity
            WHERE username = $username
              AND crypto::argon2::compare(password, $password)
          )
          DURATION FOR SESSION 1h;
        CREATE quota_test_identity:member CONTENT {
          username: "quota-member",
          password: crypto::argon2::generate("quota-member-pass")
        };
      `));
      recordSession = new Surreal();
      const rpcEndpoint = endpoint.endsWith("/rpc") ? endpoint : `${endpoint}/rpc`;
      await recordSession.connect(rpcEndpoint, { namespace, database });
      await recordSession.signin({
        namespace,
        database,
        access: "quota_test_record",
        variables: {
          username: "quota-member",
          password: "quota-member-pass",
        },
      });
      const [deniedSelect] = await recordSession
        .query<[unknown[]]>("SELECT * FROM quota_plan;")
        .collect();
      expect(deniedSelect).toEqual([]);
      const [deniedWrite] = await recordSession
        .query<[unknown[]]>(`
          CREATE quota_plan:denied CONTENT {
            plan_key: "denied",
            display_name: "Denied",
            visibility: "internal",
            status: "active"
          };
        `)
        .collect();
      expect(deniedWrite).toEqual([]);
      await expect(
        recordSession.query("DEFINE TABLE denied_structure SCHEMALESS;").collect(),
      ).rejects.toThrow();

      for (const sql of migrations) {
        expectSuccessful(await runSurrealCli(sql));
      }
      const restartSnapshot = await runSurrealCli(`
        SELECT count() AS workspaces FROM workspace GROUP ALL;
        SELECT count() AS plans FROM quota_plan GROUP ALL;
        SELECT count() AS attempts FROM quota_materialization_attempt GROUP ALL;
      `);
      expect(restartSnapshot).toContain('"workspaces":1');
      expect(restartSnapshot).toContain('"plans":1');
      expect(restartSnapshot).toContain('"attempts":1');
    },
    60_000,
  );
});
