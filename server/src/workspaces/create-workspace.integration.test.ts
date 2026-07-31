import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Surreal } from "surrealdb";
import { seedQuotaPlans } from "../db/quota-plan-seed";
import { SurrealNativeQuotaClient } from "../db/native-quota/client";
import {
  createWorkspaceCreator,
  type CreateWorkspaceSessionFactory,
} from "./create-workspace";

const RUN_INTEGRATION =
  process.env.RUN_LOCAL_SURREALDB_WORKSPACE_PROVISIONING_TESTS === "1";
const localTest = test.skipIf(!RUN_INTEGRATION);
const surrealBinary = process.env.SURREAL_BINARY ?? "surreal";
const namespace = "main";
const migrationsUrl = new URL(
  "../../../shared/sql/system/",
  import.meta.url,
);

let endpoint = "";
let workingDirectory = "";
let server: ReturnType<typeof Bun.spawn> | undefined;
const sessions = new Map<string, Surreal>();

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

const getDbSession: CreateWorkspaceSessionFactory = async (database) => {
  const existing = sessions.get(database);
  if (existing) return existing;
  const db = new Surreal();
  await db.connect(`${endpoint}/rpc`, {
    authentication: { username: "root", password: "root" },
    namespace,
    database,
  });
  sessions.set(database, db);
  return db;
};

beforeAll(async () => {
  if (!RUN_INTEGRATION) return;
  workingDirectory = await mkdtemp(
    join(tmpdir(), "surreal-ck-workspace-provisioning-"),
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

  const bootstrap = new Surreal();
  await bootstrap.connect(`${endpoint}/rpc`, {
    authentication: { username: "root", password: "root" },
  });
  await bootstrap.query(`DEFINE NAMESPACE IF NOT EXISTS ${namespace};`);
  await bootstrap.use({ namespace });
  await bootstrap.query("DEFINE DATABASE IF NOT EXISTS _system;");
  await bootstrap.close();

  const systemDb = await getDbSession("_system");
  const migrations = (await readdir(migrationsUrl))
    .filter((entry) => /^\d{3}-.+\.surql$/u.test(entry))
    .sort();
  for (const migration of migrations) {
    await systemDb.query(
      await readFile(new URL(migration, migrationsUrl), "utf8"),
    );
  }
  await seedQuotaPlans({ getDbSession, namespace });
});

afterAll(async () => {
  await Promise.all([...sessions.values()].map(async (db) => await db.close()));
  sessions.clear();
  server?.kill();
  if (server) await server.exited;
  if (workingDirectory) {
    await rm(workingDirectory, { force: true, recursive: true });
  }
});

describe("workspace provisioning against local SurrealDB", () => {
  localTest(
    "retains a quota-protected database after template failure and resumes the original reservation",
    async () => {
      const nativeQuotaClient = new SurrealNativeQuotaClient(
        await getDbSession("_system"),
      );
      const baseOptions = {
        getDbSession,
        namespace,
        nativeQuotaClient,
        loadTemplatePackScripts: async () => [],
        idpTokenScopeAdapter: {
          async updateUserScope() {
            return { accessToken: "scoped-token", expiresIn: 3600 };
          },
        },
      };
      const first = createWorkspaceCreator({
        ...baseOptions,
        generateId: () => "recover000001",
        loadTemplateScripts: async () => [{
          version: 1,
          name: "001-fail.surql",
          sql: 'THROW "template-boom";',
        }],
      });
      const input = {
        subject: "owner-recovery",
        subjectToken: "subject-token",
        email: "owner@example.com",
        name: "Recovery",
        slug: "recovery",
        resourceSource: {
          planKey: "trial",
          sourceKind: "trial" as const,
        },
      };

      const failed = await first.createWorkspace(input);
      expect(failed).toMatchObject({
        kind: "provisioning_error",
        dbName: "ws_recover000001",
      });

      const systemDb = await getDbSession("_system");
      const afterFailure = await systemDb.query<
        Array<Array<Record<string, unknown>>>
      >(
        "SELECT status, db_name FROM workspace WHERE slug = $slug;",
        { slug: input.slug },
      );
      expect(afterFailure[0]?.[0]).toMatchObject({
        status: "provisioning_error",
        db_name: "ws_recover000001",
      });

      const resumed = createWorkspaceCreator({
        ...baseOptions,
        generateId: () => "unused0000001",
        loadTemplateScripts: async () => [],
      });
      const created = await resumed.createWorkspace(input);
      expect(created).toMatchObject({
        kind: "created",
        dbName: "ws_recover000001",
      });

      const persisted = await systemDb.query<
        Array<Array<Record<string, unknown>>>
      >(`
        SELECT status, provisioning_error, desired_entitlement,
          applied_entitlement, desired_quota_projection,
          applied_quota_projection
        FROM workspace WHERE slug = $slug;
        SELECT id FROM quota_subscription_item;
        SELECT id FROM resource_entitlement;
        SELECT id FROM quota_policy_projection;
      `, { slug: input.slug });
      expect(persisted[0]?.[0]?.status).toBe("active");
      expect(persisted[0]?.[0]?.provisioning_error).toBeUndefined();
      expect(persisted[0]?.[0]?.desired_entitlement).toEqual(
        persisted[0]?.[0]?.applied_entitlement,
      );
      expect(persisted[0]?.[0]?.desired_quota_projection).toEqual(
        persisted[0]?.[0]?.applied_quota_projection,
      );
      expect(persisted[1]).toHaveLength(1);
      expect(persisted[2]).toHaveLength(1);
      expect(persisted[3]).toHaveLength(1);

      const nativeInfo = await nativeQuotaClient.info("ws_recover000001");
      expect(nativeInfo.policy?.generation).toBe(1);
      expect(nativeInfo.policy?.rules.length).toBeGreaterThan(0);
      expect(nativeInfo.ledger).toMatchObject({
        state: "ready",
        usage_trusted: true,
      });
    },
    30_000,
  );
});
