// 真实 fork SurrealDB 上验证测试物料自助的登记、计数、列出与清理：SQL 真实执行、reaper 真实删库。
// 代办开通（IdP/建库/权益）用替身：只写出它在生产里会留下的 workspace、成员索引与 ops_invitation 行。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Surreal, jsonify } from "surrealdb";

import type { InviteResult } from "../invitations/invite-service";
import { TestKitService } from "./service";

const RUN_INTEGRATION = process.env.RUN_LOCAL_SURREALDB_TEST_SUBJECT_TESTS === "1";
const localTest = test.skipIf(!RUN_INTEGRATION);
const surrealBinary = process.env.SURREAL_BINARY ?? "surreal";

const AGENT = { subject: "agent-arch", kind: "agent", capabilities: ["test.provision"] };
const A = "7e183d2f-0000-4000-8000-00000000000a";

let endpoint = "";
let workingDirectory = "";
let server: ReturnType<typeof Bun.spawn> | undefined;
let db: Surreal | undefined;
const results = new Map<string, InviteResult>();

function rows(result: unknown): Record<string, unknown>[] {
  const value = Array.isArray(result) ? jsonify(result[0]) : undefined;
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  return typeof value === "object" && value !== null ? [value as Record<string, unknown>] : [];
}

const queryClient = () => ({ query: async (sql: string, params?: Record<string, unknown>) => await db!.query(sql, params) });

async function allocatePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") { listener.close(); reject(new Error("no port")); return; }
      listener.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const probe = Bun.spawn([surrealBinary, "is-ready", "--endpoint", endpoint], { stdout: "ignore", stderr: "ignore" });
    if ((await probe.exited) === 0) return;
    await Bun.sleep(100);
  }
  throw new Error("local SurrealDB did not become ready");
}

/** 代办开通替身：按生产形状写出 workspace + 成员索引 + ops_invitation(completed)。 */
async function fakeProvision(key: string, email: string, slug: string): Promise<InviteResult> {
  const subject = `sub-${slug}`;
  const dbName = `ws_${slug.replaceAll("-", "_")}`;
  await db!.query(
    `CREATE workspace CONTENT { slug: $slug, name: $slug, db_name: $dbName, owner_subject: $subject, status: "active" };
     INSERT INTO user_workspace_index { subject: $subject, email: $email, workspace: (SELECT VALUE id FROM ONLY workspace WHERE slug = $slug LIMIT 1), db_name: $dbName, role: "admin" };
     CREATE ops_invitation CONTENT {
       idempotency_key: $key, operator_subject: "agent-arch", authorized_capability: "subscription.manage",
       email: $email, display_name: "t", workspace_slug: $slug, workspace_name: $slug, plan_key: "trial",
       reason: "r", request_digest: "d", status: "completed", activation_url_issued: true, created_at: time::now()
     };
     DEFINE DATABASE IF NOT EXISTS ${dbName};`,
    { slug, dbName, subject, email, key },
  );
  const result = {
    idempotencyKey: key, status: "completed", replayed: false,
    user: { id: subject, email, status: "pending", outcome: "created" },
    workspace: { slug, dbName, outcome: "created" }, entitlement: null, aiAllowance: null,
    delivery: { channel: "activation_url", activationUrl: `https://auth.example/a/${slug}`, pendingCollect: false, note: "" },
  } as unknown as InviteResult;
  results.set(key, { ...result, delivery: { ...result.delivery, activationUrl: null } } as InviteResult);
  return result;
}

function kit() {
  return new TestKitService({
    invites: {
      provision: async (_actor, input) => fakeProvision(input.idempotencyKey, input.email, input.workspaceSlug),
      get: async (key) => results.get(key) ?? null,
      collect: async (key) => ({ idempotencyKey: key, status: "completed", activationUrl: null, deliveredAt: null, errorCode: null, errorMessage: null }),
    },
    members: {
      async addMember(input) {
        await db!.query(
          `INSERT INTO user_workspace_index { subject: $subject, email: $email, workspace: (SELECT VALUE id FROM ONLY workspace WHERE slug = $slug LIMIT 1), db_name: (SELECT VALUE db_name FROM ONLY workspace WHERE slug = $slug LIMIT 1), role: "participant" };`,
          { subject: rows(await db!.query(`SELECT VALUE subject FROM test_subject WHERE email = $email LIMIT 1;`, { email: input.email }))[0], email: input.email, slug: input.slug },
        );
        return { kind: "added" };
      },
    },
    getSystemDb: async () => queryClient(),
    idpUserExists: async () => false,
    reaperDeps: async () => ({
      systemDb: queryClient(),
      dropDatabase: async (name: string) => { await db!.query(`REMOVE DATABASE IF EXISTS ${name};`); },
      log: () => {},
    }),
    emailPattern: "kit[+][a-z0-9-]+@example[.]com",
    maxActive: 3,
  });
}

describe("test kit on real fork SurrealDB", () => {
  beforeAll(async () => {
    if (!RUN_INTEGRATION) return;
    workingDirectory = await mkdtemp(join(tmpdir(), "surreal-ck-test-kit-"));
    const port = await allocatePort();
    endpoint = `ws://127.0.0.1:${port}`;
    server = Bun.spawn(
      [surrealBinary, "start", "--no-banner", "--log", "none", "--bind", `127.0.0.1:${port}`,
        "--user", "root", "--pass", "root", `rocksdb:${join(workingDirectory, "data")}`],
      { cwd: workingDirectory, stdout: "ignore", stderr: "ignore" },
    );
    await waitUntilReady();
    db = new Surreal();
    await db.connect(`${endpoint}/rpc`, { authentication: { username: "root", password: "root" } });
    await db.use({ namespace: "main", database: "_system" });
    const migrationsUrl = new URL("../../../shared/sql/system/", import.meta.url);
    for (const migration of (await readdir(migrationsUrl)).filter((e) => /^\d{3}-.+\.surql$/u.test(e)).sort()) {
      await db.query(await readFile(new URL(migration, migrationsUrl), "utf8"));
    }
    // 运营已登记的测试账号 A 与其测试 workspace（signal-test-1113 的形状）
    await db.query(`
      INSERT INTO workspace { id: workspace:a, slug: "signal-test-a", name: "A", db_name: "ws_signal_test_a", owner_subject: "${A}", status: "active", test_expires_at: <datetime>$exp };
      INSERT INTO user_workspace_index { subject: "${A}", email: "kit+a@example.com", workspace: workspace:a, db_name: "ws_signal_test_a", role: "admin" };
      INSERT INTO test_subject { subject: "${A}", email: "kit+a@example.com", expires_at: <datetime>$exp, origin: "ops" };
      DEFINE DATABASE ws_signal_test_a;
    `, { exp: new DateTime(new Date(Date.now() + 20 * 86_400_000)) });
  });

  afterAll(async () => {
    try { await db?.close(); } catch { /* noop */ }
    server?.kill();
    if (workingDirectory) await rm(workingDirectory, { recursive: true, force: true });
  });

  localTest("test.provision 能力能写进 platform_operator_capability（049 放宽白名单）", async () => {
    await db!.query(`
      INSERT INTO platform_operator { subject: "agent-arch", display_name: "测试物料 agent", status: "active", kind: "agent" };
      INSERT INTO platform_operator_capability { operator: (SELECT VALUE id FROM ONLY platform_operator WHERE subject = "agent-arch" LIMIT 1), capability: "test.provision", status: "active", granted_by_subject: "t" };
    `);
    const caps = rows(await db!.query(`SELECT VALUE capability FROM platform_operator_capability;`));
    expect(caps).toContain("test.provision");
  });

  localTest("开通 → 登记 30 天测试主体并标记其 workspace", async () => {
    const out = await kit().provision(AGENT, { email: "kit+b@example.com", displayName: "B", workspaceSlug: "kit-b", idempotencyKey: "b1" }) as Record<string, unknown>;
    expect(out).toMatchObject({ status: "completed", subject: "sub-kit-b", activationUrl: "https://auth.example/a/kit-b" });
    const subject = rows(await db!.query(`SELECT origin, expires_at FROM test_subject WHERE subject = "sub-kit-b";`))[0];
    expect(subject?.origin).toBe("test-kit:agent-arch");
    const ws = rows(await db!.query(`SELECT test_expires_at, test_origin FROM workspace WHERE slug = "kit-b";`))[0];
    expect(ws?.test_expires_at).toBeTruthy();
    expect(ws?.test_origin).toBe("test-kit:agent-arch");
  });

  localTest("B 加入 A 的测试 workspace；列出只含本 agent 的账号", async () => {
    expect(await kit().addMember(AGENT, { workspaceSlug: "signal-test-a", email: "kit+b@example.com" })).toMatchObject({ added: true });
    const list = await kit().list(AGENT);
    expect(list.subjects.map((s) => s.subject)).toEqual(["sub-kit-b"]);
    expect((list.subjects[0]!.workspaces as Array<{ slug: string }>).map((w) => w.slug).sort()).toEqual(["kit-b", "signal-test-a"]);
  });

  localTest("清理 B：删 B 自己的库，A 的共享测试 workspace 与库保留", async () => {
    const out = await kit().purge(AGENT, { subject: "sub-kit-b", confirm: "purge sub-kit-b" });
    expect(out).toMatchObject({ workspacesPurged: 1, workspacesSkipped: 0 });
    expect(rows(await db!.query(`SELECT slug FROM workspace;`)).map((w) => w.slug)).toEqual(["signal-test-a"]);
    expect(rows(await db!.query(`SELECT VALUE subject FROM user_workspace_index WHERE workspace = workspace:a;`))).toEqual([A]);
    const dbs = Object.keys((rows(await db!.query(`INFO FOR NS;`))[0]?.databases ?? {}) as Record<string, unknown>);
    expect(dbs).toContain("ws_signal_test_a");
    expect(dbs).not.toContain("ws_kit_b");
    expect(rows(await db!.query(`SELECT * FROM test_subject WHERE subject = "sub-kit-b";`))).toEqual([]);
  });

  localTest("清理后同 key 的 status 不复活登记；开通中的行计入上限", async () => {
    expect((await kit().status(AGENT, { idempotencyKey: "b1" })).status).toBe("purged");
    expect(rows(await db!.query(`SELECT * FROM test_subject WHERE origin = "test-kit:agent-arch";`))).toEqual([]);
    for (const n of [1, 2, 3]) {
      await db!.query(`CREATE ops_invitation CONTENT {
        idempotency_key: $key, operator_subject: "agent-arch", authorized_capability: "subscription.manage",
        email: "x", display_name: "t", workspace_slug: "s", workspace_name: "s", plan_key: "trial",
        reason: "r", request_digest: "d", status: "processing", activation_url_issued: false, created_at: time::now()
      };`, { key: `test-kit:agent-arch:slow${n}` });
    }
    const error = await kit().provision(AGENT, { email: "kit+c@example.com", displayName: "C", workspaceSlug: "kit-c", idempotencyKey: "c1" })
      .then(() => null, (e: { code?: string }) => e.code);
    expect(error).toBe("limit_reached");
    expect((await kit().list(AGENT)).inFlight).toHaveLength(3);
  });
});
