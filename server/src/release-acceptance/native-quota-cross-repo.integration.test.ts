import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractNativeQuotaError,
  mapQuotaFailure,
  type NativeQuotaRule,
} from "@surreal-ck/shared/native-quota";
import { Surreal } from "surrealdb";
import {
  SurrealNativeQuotaClient,
} from "../db/native-quota/client";
import {
  NativeQuotaStartupGateError,
  probeNativeQuotaHttp,
} from "../db/native-quota/startup-gate";

const RUN_CROSS_REPO_E2E =
  process.env.RUN_NATIVE_QUOTA_CROSS_REPO_E2E === "1";
const crossRepoTest = test.skipIf(!RUN_CROSS_REPO_E2E);
const REQUIRE_VANILLA_REFUSAL =
  process.env.NATIVE_QUOTA_E2E_REQUIRE_VANILLA !== "0";
const namespace = "tenant";
const primaryDatabase = "ws_release_e2e";
const lifecycleDatabase = "ws_release_lifecycle";
const rootUser = "root";
const rootPassword = "root";
const namespaceOwner = "quota_operator";
const namespaceOwnerPassword = "quota-operator-pass";
const databaseOwner = "workspace_owner";
const databaseOwnerPassword = "workspace-owner-pass";
const participantEmail = "member@example.test";
const participantPassword = "member-pass";

type ManagedProcess = ReturnType<typeof Bun.spawn>;

const openedClients: Surreal[] = [];
let workingDirectory = "";
let primaryDataDirectory = "";
let rpcUrl = "";
let httpUrl = "";
let port = 0;
let engine: ManagedProcess | undefined;

const primaryRules = [
  {
    rule_id: "ent_tables",
    resource: "table",
    selector: { kind: "regex", pattern: "^ent_" },
    limit: { kind: "finite", value: 3 },
  },
  {
    rule_id: "forbidden_table",
    resource: "table",
    selector: { kind: "exact", table: "ent_forbidden" },
    limit: { kind: "finite", value: 0 },
  },
  {
    rule_id: "ent_fields",
    resource: "field",
    selector: { kind: "regex", pattern: "^ent_" },
    limit: { kind: "finite", value: 2 },
  },
  {
    rule_id: "ent_records",
    resource: "record",
    selector: { kind: "regex", pattern: "^ent_" },
    limit: { kind: "finite", value: 3 },
  },
  {
    rule_id: "claim_records",
    resource: "record",
    selector: { kind: "exact", table: "ent_claim" },
    limit: { kind: "finite", value: 2 },
  },
] as const satisfies readonly NativeQuotaRule[];

function repositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

function candidateBinary(): string {
  return process.env.NATIVE_QUOTA_E2E_BINARY
    ?? resolve(repositoryRoot(), "../surrealdb/target/debug/surreal");
}

async function allocatePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
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
        error ? reject(error) : resolvePort(address.port)
      );
    });
  });
}

async function waitForHttp(url: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (engine?.exitCode !== null) {
      throw new Error(
        `native quota candidate exited before readiness (code ${engine?.exitCode})`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The socket is expected to refuse connections while the process starts.
    }
    await Bun.sleep(100);
  }
  throw new Error(`SurrealDB did not become ready at ${url}`);
}

async function startCandidate(dataDirectory: string): Promise<void> {
  if (engine) throw new Error("candidate process is already running");
  engine = Bun.spawn([
    candidateBinary(),
    "start",
    "--no-banner",
    "--log",
    "none",
    "--bind",
    `127.0.0.1:${port}`,
    "--user",
    rootUser,
    "--pass",
    rootPassword,
    `rocksdb:${dataDirectory}`,
  ], {
    cwd: workingDirectory,
    stdout: "ignore",
    stderr: "pipe",
  });
  await waitForHttp(`${httpUrl}/health`);
  const capability = await probeNativeQuotaHttp({
    surrealUrl: rpcUrl,
    production: true,
  });
  const expectedGitSha = process.env.NATIVE_QUOTA_E2E_EXPECTED_GIT_SHA;
  if (expectedGitSha && capability.build.git_sha !== expectedGitSha) {
    throw new Error(
      `candidate git SHA mismatch: ${capability.build.git_sha} != ${expectedGitSha}`,
    );
  }
}

async function stopCandidate(): Promise<void> {
  const current = engine;
  engine = undefined;
  if (!current || current.exitCode !== null) return;
  current.kill("SIGTERM");
  const exited = await Promise.race([
    current.exited.then(() => true),
    Bun.sleep(5_000).then(() => false),
  ]);
  if (!exited) {
    current.kill("SIGKILL");
    await current.exited;
  }
}

async function closeClients(): Promise<void> {
  await Promise.allSettled(openedClients.splice(0).map((client) => client.close()));
}

async function openRoot(database?: string): Promise<Surreal> {
  const client = new Surreal();
  openedClients.push(client);
  await client.connect(rpcUrl, {
    ...(database ? { namespace, database } : {}),
    authentication: { username: rootUser, password: rootPassword },
  });
  return client;
}

async function openNamespaceOwner(database: string): Promise<Surreal> {
  const client = new Surreal();
  openedClients.push(client);
  await client.connect(rpcUrl, {
    namespace,
    database,
    authentication: {
      namespace,
      username: namespaceOwner,
      password: namespaceOwnerPassword,
    },
  });
  return client;
}

async function openDatabaseOwner(database: string): Promise<Surreal> {
  const client = new Surreal();
  openedClients.push(client);
  await client.connect(rpcUrl, {
    namespace,
    database,
    authentication: {
      namespace,
      database,
      username: databaseOwner,
      password: databaseOwnerPassword,
    },
  });
  return client;
}

async function openParticipant(database: string): Promise<Surreal> {
  const client = new Surreal();
  openedClients.push(client);
  await client.connect(rpcUrl, { namespace, database });
  await client.signin({
    namespace,
    database,
    access: "participant_test",
    variables: {
      email: participantEmail,
      password: participantPassword,
    },
  });
  return client;
}

async function firstResult<T>(client: Surreal, sql: string): Promise<T> {
  const values = await client.query(sql).collect();
  if (values.length !== 1) {
    throw new Error(`expected one statement result, received ${values.length}`);
  }
  return values[0] as T;
}

async function recordCount(client: Surreal, table: string): Promise<number> {
  const rows = await firstResult<Array<{ count: number }>>(
    client,
    `SELECT count() FROM ${table} GROUP ALL;`,
  );
  return rows[0]?.count ?? 0;
}

async function capturedError(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("operation unexpectedly succeeded");
}

async function quotaError(operation: Promise<unknown>, code: string): Promise<unknown> {
  const error = await capturedError(operation);
  const envelope = extractNativeQuotaError(error);
  if (envelope?.code !== code) {
    throw new Error(
      `expected structured ${code}, received ${
        JSON.stringify(error, Object.getOwnPropertyNames(error as object))
      }`,
      { cause: error },
    );
  }
  return error;
}

async function bootstrap(): Promise<void> {
  const root = await openRoot();
  await root.query(`
    DEFINE NAMESPACE IF NOT EXISTS ${namespace};
    USE NS ${namespace};
    DEFINE USER ${namespaceOwner} ON NAMESPACE
      PASSWORD "${namespaceOwnerPassword}" ROLES OWNER;
    DEFINE DATABASE IF NOT EXISTS ${primaryDatabase};
    DEFINE DATABASE IF NOT EXISTS ${lifecycleDatabase};
  `).collect();

  for (const database of [primaryDatabase, lifecycleDatabase]) {
    await root.use({ namespace, database });
    await root.query(`
      DEFINE USER ${databaseOwner} ON DATABASE
        PASSWORD "${databaseOwnerPassword}" ROLES OWNER;
      DEFINE TABLE user SCHEMAFULL PERMISSIONS FULL;
      DEFINE FIELD email ON TABLE user TYPE string;
      DEFINE FIELD password ON TABLE user TYPE string;
      DEFINE FIELD is_admin ON TABLE user TYPE bool DEFAULT false;
      DEFINE ACCESS participant_test ON DATABASE TYPE RECORD
        SIGNIN (
          SELECT * FROM user
          WHERE email = $email
            AND crypto::argon2::compare(password, $password)
        )
        DURATION FOR SESSION 1h;
      CREATE user:member CONTENT {
        email: "${participantEmail}",
        password: crypto::argon2::generate("${participantPassword}"),
        is_admin: false,
      };
    `).collect();
  }
}

async function retryQuotaContention(operation: () => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      const code = extractNativeQuotaError(error)?.code;
      if (code !== "quota_conflict" && code !== "quota_policy_changed") throw error;
      await Bun.sleep(5 * (attempt + 1));
    }
  }
  throw new Error("quota contention did not settle after 12 attempts");
}

beforeAll(async () => {
  if (!RUN_CROSS_REPO_E2E) return;
  workingDirectory = await mkdtemp(
    join(tmpdir(), "surreal-ck-native-quota-release-"),
  );
  primaryDataDirectory = join(workingDirectory, "data");
  port = await allocatePort();
  httpUrl = `http://127.0.0.1:${port}`;
  rpcUrl = `ws://127.0.0.1:${port}/rpc`;
  await startCandidate(primaryDataDirectory);
  await bootstrap();
});

afterAll(async () => {
  await closeClients();
  await stopCandidate();
  if (workingDirectory) {
    await rm(workingDirectory, { recursive: true, force: true });
  }
});

describe("SCK-NQ-10 cross-repository native quota release acceptance", () => {
  crossRepoTest("bypass、规则、并发、IAM、生命周期与恢复矩阵", async () => {
    const nsOwner = await openNamespaceOwner(primaryDatabase);
    const owner = await openDatabaseOwner(primaryDatabase);
    const native = new SurrealNativeQuotaClient(nsOwner);

    const applied = await native.applyPolicy({
      database: primaryDatabase,
      rules: primaryRules,
    });
    expect(applied.operation).toBe("define_quota");
    expect(applied.after.generation).toBe(1);

    for (const statement of [
      `DEFINE QUOTA OVERWRITE ON DATABASE ${primaryDatabase}
        EXPECT GENERATION 1
        RULE escape FOR RECORD MATCH REGEX /.*/ LIMIT UNLIMITED;`,
      `ALTER QUOTA ON DATABASE ${primaryDatabase}
        EXPECT GENERATION 1
        SET RULE ent_records FOR RECORD MATCH REGEX /^ent_/ LIMIT UNLIMITED;`,
      `REMOVE QUOTA ON DATABASE ${primaryDatabase} EXPECT GENERATION 1;`,
      `REBUILD QUOTA ON DATABASE ${primaryDatabase};`,
      `OPTION IMPORT;
       DEFINE QUOTA OVERWRITE ON DATABASE ${primaryDatabase}
         EXPECT GENERATION 1
         RULE escape FOR RECORD MATCH REGEX /.*/ LIMIT UNLIMITED;`,
    ]) {
      const denied = await capturedError(owner.query(statement).collect());
      expect(extractNativeQuotaError(denied)).toBeNull();
    }
    const ownerInfo = await new SurrealNativeQuotaClient(owner).info(primaryDatabase);
    expect(ownerInfo.policy?.generation).toBe(1);

    await owner.query(`
      DEFINE TABLE legacy_quota_plan SCHEMALESS;
      DEFINE TABLE legacy_quota_counter SCHEMALESS;
      DEFINE TABLE legacy_quota_event SCHEMALESS;
      CREATE legacy_quota_plan:active SET record_limit = 999999999;
      CREATE legacy_quota_counter:records SET used = -999999999;
      CREATE legacy_quota_event:disable SET active = false;
      UPDATE legacy_quota_plan:active SET record_limit = NONE;
      DELETE legacy_quota_counter:records;
      DELETE legacy_quota_event:disable;
    `).collect();

    await quotaError(
      owner.query("DEFINE TABLE ent_forbidden SCHEMALESS;").collect(),
      "quota_exceeded",
    );
    await owner.query(`
      DEFINE TABLE ent_claim SCHEMALESS PERMISSIONS FULL;
      DEFINE FIELD claimant ON TABLE ent_claim TYPE string;
      DEFINE FIELD amount ON TABLE ent_claim TYPE number;
    `).collect();
    await quotaError(
      owner.query("DEFINE FIELD escape ON TABLE ent_claim TYPE any;").collect(),
      "quota_exceeded",
    );
    await owner.query(`
      CREATE ent_claim:one SET claimant = "one", amount = 1;
      CREATE ent_claim:two SET claimant = "two", amount = 2;
    `).collect();
    await quotaError(
      owner.query(
        "CREATE ent_claim:three SET claimant = 'three', amount = 3;",
      ).collect(),
      "quota_exceeded",
    );

    await owner.query("DEFINE TABLE ent_batch SCHEMALESS PERMISSIONS FULL;").collect();
    await owner.query(`
      INSERT INTO ent_batch [
        { id: ent_batch:one, value: 1 },
        { id: ent_batch:two, value: 2 }
      ];
    `).collect();
    await quotaError(
      owner.query(`
        INSERT INTO ent_batch [
          { id: ent_batch:three, value: 3 },
          { id: ent_batch:four, value: 4 }
        ];
      `).collect(),
      "quota_exceeded",
    );
    expect(await recordCount(owner, "ent_batch")).toBe(2);

    await owner.query(
      "DEFINE TABLE ent_participant SCHEMALESS PERMISSIONS FULL;",
    ).collect();
    const participantDdl = await openParticipant(primaryDatabase);
    await expect(
      participantDdl.query("DEFINE TABLE ent_escape SCHEMALESS;").collect(),
    ).rejects.toThrow();

    const contenders = await Promise.all(
      Array.from({ length: 10 }, () => openParticipant(primaryDatabase)),
    );
    const outcomes = await Promise.allSettled(
      contenders.map((client, index) =>
        retryQuotaContention(async () => {
          await client.query(
            `CREATE ent_participant:r${index} SET value = ${index};`,
          ).collect();
        })
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(3);
    expect(await recordCount(owner, "ent_participant")).toBe(3);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(extractNativeQuotaError(outcome.reason)?.code).toBe("quota_exceeded");
      }
    }

    const wsError = await quotaError(
      participantDdl.query(
        "CREATE ent_participant:browser_over SET draft = 'preserve-me';",
      ).collect(),
      "quota_exceeded",
    );
    const participantFailure = mapQuotaFailure(wsError, {
      kind: "participant",
      operated_table: "ent_participant",
    });
    expect(participantFailure.kind).toBe("exceeded");
    expect(participantFailure.preserve_draft).toBe(true);
    if (participantFailure.kind === "exceeded") {
      expect(participantFailure.violations).toEqual([{
        resource: "record",
        table: "ent_participant",
      }]);
    }
    const adminFailure = mapQuotaFailure(wsError, { kind: "workspace_admin" });
    expect(adminFailure.kind).toBe("exceeded");
    if (adminFailure.kind === "exceeded") {
      expect(adminFailure.violations[0]?.limit).toBe(3);
    }

    const httpResponse = await fetch(`${httpUrl}/sql`, {
      method: "POST",
      headers: {
        "accept": "application/json",
        "authorization": `Basic ${
          Buffer.from(`${databaseOwner}:${databaseOwnerPassword}`).toString("base64")
        }`,
        "content-type": "text/plain",
        "surreal-auth-ns": namespace,
        "surreal-auth-db": primaryDatabase,
        "surreal-ns": namespace,
        "surreal-db": primaryDatabase,
      },
      body: "CREATE ent_participant:http_over;",
    });
    expect(httpResponse.status).toBe(200);
    const httpResults = await httpResponse.json() as Array<Record<string, unknown>>;
    expect(httpResults[0]?.status).toBe("ERR");
    expect(extractNativeQuotaError(httpResults[0])?.code).toBe("quota_exceeded");

    await owner.query(`
      DEFINE TABLE sheet SCHEMALESS;
      DEFINE EVENT resource_quota_guard ON TABLE sheet
        WHEN $event = "CREATE"
        THEN (CREATE legacy_quota_event SET source = $after.id);
    `).collect();
    const cutover = await native.cutoverLegacyQuotaEvents({
      database: primaryDatabase,
      rules: primaryRules,
      expectedGeneration: 1,
      legacyEventTables: ["sheet"],
    });
    expect(cutover.after.generation).toBe(1);
    expect(cutover.changed).toBe(false);
    const eventPresent = await firstResult<boolean>(
      owner,
      "RETURN (INFO FOR TABLE sheet).events.resource_quota_guard != NONE;",
    );
    expect(eventPresent).toBe(false);
    await quotaError(
      owner.query("CREATE ent_participant:still_blocked;").collect(),
      "quota_exceeded",
    );

    const driftedRules = primaryRules.map((rule) =>
      rule.rule_id === "ent_records"
        ? {
          ...rule,
          limit: { kind: "finite" as const, value: 4 },
        }
        : rule
    );
    const externalDrift = await native.applyPolicy({
      database: primaryDatabase,
      rules: driftedRules,
      expectedGeneration: 1,
    });
    expect(externalDrift.after.generation).toBe(2);
    const staleGeneration = await quotaError(
      native.applyPolicy({
        database: primaryDatabase,
        rules: primaryRules,
        expectedGeneration: 1,
      }),
      "quota_generation_mismatch",
    );
    expect(mapQuotaFailure(staleGeneration, { kind: "operator" }).kind)
      .toBe("generation_mismatch");
    const driftRepair = await native.applyPolicy({
      database: primaryDatabase,
      rules: primaryRules,
      expectedGeneration: 2,
    });
    expect(driftRepair.after.generation).toBe(3);
    const rebuild = await native.rebuild(primaryDatabase);
    expect(rebuild.operation).toBe("rebuild_quota");
    expect(rebuild.after.ledger_state).toBe("ready");

    const lifecycleOwner = await openDatabaseOwner(lifecycleDatabase);
    const lifecycleNsOwner = await openNamespaceOwner(lifecycleDatabase);
    const lifecycleNative = new SurrealNativeQuotaClient(lifecycleNsOwner);
    const lifecycleRule = (limit: number): readonly NativeQuotaRule[] => [{
      rule_id: "lifecycle_records",
      resource: "record",
      selector: { kind: "exact", table: "ent_lifecycle" },
      limit: { kind: "finite", value: limit },
    }];
    await lifecycleNative.applyPolicy({
      database: lifecycleDatabase,
      rules: lifecycleRule(2),
    });
    await lifecycleOwner.query(`
      DEFINE TABLE ent_lifecycle SCHEMALESS PERMISSIONS FULL;
      CREATE ent_lifecycle:one SET value = 1;
      CREATE ent_lifecycle:two SET value = 2;
    `).collect();
    await quotaError(
      lifecycleOwner.query("CREATE ent_lifecycle:before_upgrade;").collect(),
      "quota_exceeded",
    );
    await lifecycleNative.applyPolicy({
      database: lifecycleDatabase,
      rules: lifecycleRule(5),
      expectedGeneration: 1,
    });
    const upgradeReadback = await lifecycleNative.info(lifecycleDatabase);
    expect(upgradeReadback.policy?.generation).toBe(2);
    expect(upgradeReadback.policy?.rules[0]?.limit).toEqual({
      kind: "finite",
      value: 5,
    });
    await lifecycleOwner.query(`
      CREATE ent_lifecycle:three SET value = 3;
      CREATE ent_lifecycle:four SET value = 4;
      CREATE ent_lifecycle:five SET value = 5;
    `).collect();

    await lifecycleNative.applyPolicy({
      database: lifecycleDatabase,
      rules: lifecycleRule(2),
      expectedGeneration: 2,
    });
    const downgradeReadback = await lifecycleNative.info(lifecycleDatabase);
    expect(downgradeReadback.policy?.generation).toBe(3);
    const lifecycleUsage = downgradeReadback.usage?.tables.find(
      (entry) => entry.table === "ent_lifecycle",
    );
    expect(lifecycleUsage?.record.used).toBe(5);
    expect(lifecycleUsage?.record.exceeded).toBe(true);
    expect(await recordCount(lifecycleOwner, "ent_lifecycle")).toBe(5);
    await quotaError(
      lifecycleOwner.query("CREATE ent_lifecycle:six SET value = 6;").collect(),
      "quota_exceeded",
    );
    await lifecycleOwner.query(`
      UPDATE ent_lifecycle:one SET value = 10;
      DELETE ent_lifecycle:two;
      BEGIN TRANSACTION;
      DELETE ent_lifecycle:three;
      CREATE ent_lifecycle:replacement SET value = 30;
      COMMIT TRANSACTION;
    `).collect();
    expect(await recordCount(lifecycleOwner, "ent_lifecycle")).toBe(4);

    await closeClients();
    await stopCandidate();
    await startCandidate(primaryDataDirectory);
    const afterRestartOwner = await openDatabaseOwner(primaryDatabase);
    const afterRestartNsOwner = await openNamespaceOwner(primaryDatabase);
    const afterRestartInfo = await new SurrealNativeQuotaClient(afterRestartNsOwner)
      .info(primaryDatabase);
    expect(afterRestartInfo.policy?.generation).toBe(3);
    expect(afterRestartInfo.ledger.usage_trusted).toBe(true);
    await quotaError(
      afterRestartOwner.query("CREATE ent_participant:after_restart;").collect(),
      "quota_exceeded",
    );

    await closeClients();
    await stopCandidate();
    const snapshotDirectory = join(workingDirectory, "snapshot");
    await cp(primaryDataDirectory, snapshotDirectory, { recursive: true });
    await startCandidate(primaryDataDirectory);
    const mutationOwner = await openDatabaseOwner(primaryDatabase);
    await mutationOwner.query("DELETE ent_claim:one;").collect();
    expect(await recordCount(mutationOwner, "ent_claim")).toBe(1);
    await closeClients();
    await stopCandidate();

    await startCandidate(snapshotDirectory);
    const restoredOwner = await openDatabaseOwner(primaryDatabase);
    const restoredNsOwner = await openNamespaceOwner(primaryDatabase);
    expect(await recordCount(restoredOwner, "ent_claim")).toBe(2);
    const restoredInfo = await new SurrealNativeQuotaClient(restoredNsOwner)
      .info(primaryDatabase);
    expect(restoredInfo.policy?.generation).toBe(3);
    expect(restoredInfo.ledger.usage_trusted).toBe(true);
  }, 180_000);

  crossRepoTest("vanilla SurrealDB 被生产启动门拒绝", async () => {
    if (!REQUIRE_VANILLA_REFUSAL) return;
    const externalVanillaRpc = process.env.NATIVE_QUOTA_E2E_VANILLA_URL;
    if (externalVanillaRpc) {
      const failure = await capturedError(probeNativeQuotaHttp({
        surrealUrl: externalVanillaRpc,
        production: true,
      }));
      expect(failure).toBeInstanceOf(NativeQuotaStartupGateError);
      if (failure instanceof NativeQuotaStartupGateError) {
        expect(failure.stage).toBe("capability");
      }
      return;
    }
    const vanillaPort = await allocatePort();
    const vanillaHttp = `http://127.0.0.1:${vanillaPort}`;
    const vanilla = Bun.spawn([
      process.env.NATIVE_QUOTA_E2E_VANILLA_BINARY ?? "surreal",
      "start",
      "--no-banner",
      "--log",
      "none",
      "--bind",
      `127.0.0.1:${vanillaPort}`,
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
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (vanilla.exitCode !== null) {
          throw new Error(
            `vanilla SurrealDB exited before readiness (code ${vanilla.exitCode})`,
          );
        }
        try {
          if ((await fetch(`${vanillaHttp}/health`)).ok) {
            ready = true;
            break;
          }
        } catch {
          await Bun.sleep(100);
        }
      }
      if (!ready) throw new Error("vanilla SurrealDB did not become ready");
      const failure = await capturedError(probeNativeQuotaHttp({
        surrealUrl: `ws://127.0.0.1:${vanillaPort}/rpc`,
        production: true,
      }));
      expect(failure).toBeInstanceOf(NativeQuotaStartupGateError);
      if (failure instanceof NativeQuotaStartupGateError) {
        expect(failure.stage).toBe("capability");
      }
    } finally {
      if (vanilla.exitCode === null) {
        vanilla.kill("SIGTERM");
        await vanilla.exited;
      }
    }
  }, 30_000);
});
