import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordId, Surreal } from "surrealdb";
import { createMemberManager } from "./member-manager";
import { createWorkspaceScopeModule } from "./workspace-scope";

const run = process.env.RUN_LOCAL_SURREALDB_MEMBER_REJOIN_TESTS === "1";
const localTest = test.skipIf(!run);
const sessions = new Map<string, Surreal>();
let directory = "";
let server: ReturnType<typeof Bun.spawn> | undefined;
let endpoint = "";

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") return reject(new Error("no test port"));
      listener.close(() => resolve(address.port));
    });
  });
}

async function getDbSession(database: string): Promise<Surreal> {
  const existing = sessions.get(database);
  if (existing) return existing;
  const db = new Surreal();
  await db.connect(`${endpoint}/rpc`, {
    authentication: { username: "root", password: "root" },
    namespace: "main",
    database,
  });
  sessions.set(database, db);
  return db;
}

beforeAll(async () => {
  if (!run) return;
  directory = await mkdtemp(join(tmpdir(), "surreal-ck-member-rejoin-"));
  endpoint = `ws://127.0.0.1:${await freePort()}`;
  server = Bun.spawn([
    process.env.SURREAL_BINARY ?? "surreal", "start", "--no-banner", "--log", "none",
    "--bind", endpoint.slice(5), "--user", "root", "--pass", "root",
    `rocksdb:${join(directory, "data")}`,
  ], { stdout: "ignore", stderr: "pipe" });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const probe = Bun.spawn([process.env.SURREAL_BINARY ?? "surreal", "is-ready", "--endpoint", endpoint], {
      stdout: "ignore", stderr: "ignore",
    });
    if (await probe.exited === 0) break;
    if (attempt === 49) throw new Error("local SurrealDB did not become ready");
    await Bun.sleep(100);
  }
  const bootstrap = new Surreal();
  await bootstrap.connect(`${endpoint}/rpc`, { authentication: { username: "root", password: "root" } });
  await bootstrap.query("DEFINE NAMESPACE IF NOT EXISTS main; USE NS main; DEFINE DATABASE IF NOT EXISTS _system; DEFINE DATABASE IF NOT EXISTS ws_abc;");
  await bootstrap.close();

  const system = await getDbSession("_system");
  await system.query(`
    DEFINE TABLE workspace SCHEMALESS;
    DEFINE TABLE system_admin SCHEMALESS;
    DEFINE INDEX workspace_slug_unique ON TABLE workspace FIELDS slug UNIQUE;
    DEFINE TABLE user_workspace_index SCHEMALESS;
    DEFINE INDEX user_workspace_subject_workspace_unique ON TABLE user_workspace_index FIELDS subject, workspace UNIQUE;
    CREATE workspace:abc CONTENT {
      slug: "abc", db_name: "ws_abc", name: "ABC", status: "active",
      desired_entitlement: "entitlement:one", applied_entitlement: "entitlement:one",
      desired_quota_projection: "projection:one", applied_quota_projection: "projection:one",
      quota_migration_state: "native_verified"
    };
    CREATE workspace_quota_runtime:abc CONTENT {
      workspace: workspace:abc, ledger_state: "ready", usage_trusted: true,
      last_native_audit_at: time::now()
    };
  `);
  const workspace = await getDbSession("ws_abc");
  await workspace.query(`
    DEFINE TABLE user SCHEMALESS;
    DEFINE INDEX user_email_unique ON TABLE user FIELDS email UNIQUE;
    CREATE user:admin CONTENT {
      email: "admin@example.test", subject: "admin-sub", kind: "human",
      is_admin: true, disabled_at: NONE
    };
  `);
});

afterAll(async () => {
  await Promise.all([...sessions.values()].map((db) => db.close()));
  sessions.clear();
  server?.kill();
  if (server) await server.exited;
  if (directory) await rm(directory, { recursive: true, force: true });
});

localTest("remove → re-add → switch retains one index row and repairs legacy duplicate rows", async () => {
  const manager = createMemberManager({ getDbSession, namespace: "main" });
  const scope = createWorkspaceScopeModule({ getDbSession, namespace: "main" });
  const input = { callerSubject: "admin-sub", slug: "abc", email: "member@example.test", isAdmin: false };
  const identity = { subject: "member-sub", email: input.email, workspaceSlug: "abc" };
  const system = await getDbSession("_system");

  expect(await manager.addMember(input)).toEqual({ kind: "added" });
  expect(await scope.switchWorkspace(identity)).toEqual({ kind: "switched", scope: { db: "ws_abc", ac: "participant" } });
  const userRows = await (await getDbSession("ws_abc")).query(
    "SELECT id FROM user WHERE email = $email;", { email: input.email },
  ) as Array<Array<{ id: unknown }>>;
  const userId = (userRows[0]?.[0]?.id as RecordId).id as string;
  expect(await manager.removeMember({ callerSubject: "admin-sub", slug: "abc", userId })).toEqual({ kind: "removed" });
  expect(await scope.listWorkspaces(identity)).toMatchObject({ workspaces: [] });
  expect(await manager.addMember(input)).toEqual({ kind: "added" });
  expect(await scope.switchWorkspace(identity)).toEqual({ kind: "switched", scope: { db: "ws_abc", ac: "participant" } });

  let rows = await system.query(
    "SELECT id, subject, disabled_at FROM user_workspace_index WHERE email = $email;", { email: input.email },
  ) as Array<Array<{ id: unknown; subject?: string; disabled_at?: unknown }>>;
  expect(rows[0]).toHaveLength(1);
  expect(rows[0]?.[0]?.subject).toBe("member-sub");
  expect(rows[0]?.[0]?.disabled_at).toBeUndefined();

  // 模拟旧版本遗留状态：已绑定的旧行 disabled，另有 active 的 NONE 行。
  await system.query("UPDATE user_workspace_index SET disabled_at = time::now() WHERE email = $email;", { email: input.email });
  await system.query(`INSERT INTO user_workspace_index {
    subject: NONE, email: $email, workspace: workspace:abc,
    db_name: "ws_abc", role: "participant", disabled_at: NONE
  };`, { email: input.email });
  expect(await scope.switchWorkspace(identity)).toEqual({ kind: "switched", scope: { db: "ws_abc", ac: "participant" } });
  rows = await system.query("SELECT id, subject, disabled_at FROM user_workspace_index WHERE email = $email;", { email: input.email }) as typeof rows;
  expect(rows[0]).toHaveLength(2);
  expect(rows[0]?.filter((row) => row.disabled_at === undefined)).toHaveLength(1);
  expect(rows[0]?.find((row) => row.disabled_at === undefined)?.subject).toBe("member-sub");
});
