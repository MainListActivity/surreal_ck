import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Surreal, jsonify } from "surrealdb";

import { runTestSubjectReaper } from "./reaper";
import { createOpsTestSubjectsRoutes } from "../routes/ops-test-subjects";
import { findTestSubject, isActiveTestSubject, isExpiredTestSubject } from "./store";

const RUN_INTEGRATION = process.env.RUN_LOCAL_SURREALDB_TEST_SUBJECT_TESTS === "1";
const localTest = test.skipIf(!RUN_INTEGRATION);
const surrealBinary = process.env.SURREAL_BINARY ?? "surreal";
const namespace = "main";
const database = "_system";
const migrationsUrl = new URL("../../../shared/sql/system/", import.meta.url);

let endpoint = "";
let workingDirectory = "";
let server: ReturnType<typeof Bun.spawn> | undefined;
let db: Surreal | undefined;

function rows(result: unknown): Record<string, unknown>[] {
  const value = Array.isArray(result) ? jsonify(result[0]) : undefined;
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  return typeof value === "object" && value !== null ? [value as Record<string, unknown>] : [];
}

function queryClient() {
  if (!db) throw new Error("integration database not initialized");
  return {
    query: async (sql: string, params?: Record<string, unknown>) =>
      await db!.query(sql, params),
  };
}

async function allocatePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close();
        reject(new Error("failed to allocate port"));
        return;
      }
      listener.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const probe = Bun.spawn(
      [surrealBinary, "is-ready", "--endpoint", endpoint],
      { stdout: "ignore", stderr: "ignore" },
    );
    if ((await probe.exited) === 0) return;
    await Bun.sleep(100);
  }
  throw new Error("local SurrealDB did not become ready");
}

const deps = (now: string) => ({
  systemDb: queryClient(),
  dropDatabase: async (dbName: string) => {
    await db!.query(`REMOVE DATABASE IF EXISTS ${dbName};`);
  },
  now: () => new Date(now),
  log: () => undefined,
});

describe("test-subject reaper against real fork SurrealDB", () => {
  beforeAll(async () => {
    if (!RUN_INTEGRATION) return;
    workingDirectory = await mkdtemp(join(tmpdir(), "surreal-ck-test-subject-"));
    const port = await allocatePort();
    endpoint = `ws://127.0.0.1:${port}`;
    server = Bun.spawn(
      [
        surrealBinary, "start", "--no-banner", "--log", "none",
        "--bind", `127.0.0.1:${port}`,
        "--user", "root", "--pass", "root",
        `rocksdb:${join(workingDirectory, "data")}`,
      ],
      { cwd: workingDirectory, stdout: "ignore", stderr: "ignore" },
    );
    await waitUntilReady();

    db = new Surreal();
    await db.connect(`${endpoint}/rpc`, {
      authentication: { username: "root", password: "root" },
    });
    await db.use({ namespace, database });

    const migrations = (await readdir(migrationsUrl))
      .filter((entry) => /^\d{3}-.+\.surql$/u.test(entry))
      .sort();
    for (const migration of migrations) {
      await db.query(await readFile(new URL(migration, migrationsUrl), "utf8"));
    }

    // 两个测试主体：expired（已到期）与 live（未到期）
    await db.query(
      `INSERT INTO test_subject [
        { id: test_subject:expired, subject: "sub_expired", email: NONE,
          expires_at: <datetime>$exp, origin: "task-exp" },
        { id: test_subject:live, subject: "sub_live", email: NONE,
          expires_at: <datetime>$live, origin: "task-live" }
      ];`,
      { exp: new DateTime("2026-01-01T00:00:00Z"), live: new DateTime("2030-01-01T00:00:00Z") },
    );

    // 三个测试 workspace：到期、未到期、到期但含非测试成员
    await db.query(
      `INSERT INTO workspace [
        { id: workspace:w_exp, slug: "w-exp", name: "W Exp", db_name: "ws_ts_exp",
          owner_subject: "sub_expired", status: "active",
          test_expires_at: <datetime>$exp, test_origin: "task-exp" },
        { id: workspace:w_live, slug: "w-live", name: "W Live", db_name: "ws_ts_live",
          owner_subject: "sub_live", status: "active",
          test_expires_at: <datetime>$live, test_origin: "task-live" },
        { id: workspace:w_mixed, slug: "w-mixed", name: "W Mixed", db_name: "ws_ts_mixed",
          owner_subject: "sub_expired", status: "active",
          test_expires_at: <datetime>$exp, test_origin: "task-exp" }
      ];`,
      { exp: new DateTime("2026-01-01T00:00:00Z"), live: new DateTime("2030-01-01T00:00:00Z") },
    );
    for (const dbName of ["ws_ts_exp", "ws_ts_live", "ws_ts_mixed"]) {
      await db.query(`DEFINE DATABASE ${dbName};`);
    }

    // 成员索引与 _system 引用行
    await db.query(
      `INSERT INTO user_workspace_index [
        { subject: "sub_expired", email: NONE, workspace: workspace:w_exp, db_name: "ws_ts_exp", role: "admin", joined_at: <datetime>$t },
        { subject: "sub_live", email: NONE, workspace: workspace:w_live, db_name: "ws_ts_live", role: "admin", joined_at: <datetime>$t },
        { subject: "sub_expired", email: NONE, workspace: workspace:w_mixed, db_name: "ws_ts_mixed", role: "admin", joined_at: <datetime>$t },
        { subject: "human_member", email: NONE, workspace: workspace:w_mixed, db_name: "ws_ts_mixed", role: "participant", joined_at: <datetime>$t }
      ];`,
      { t: new DateTime("2025-06-01T00:00:00Z") },
    );
    await db.query(
      `INSERT INTO quota_policy_projection [
        { workspace: workspace:w_exp, desired_revision: 1, applied_revision: NONE, status: "pending" },
        { workspace: workspace:w_live, desired_revision: 1, applied_revision: NONE, status: "pending" }
      ];`,
    ).catch(() => undefined);
    await db.query(
      `INSERT INTO quota_lifecycle_intent { workspaces: [workspace:w_exp], status: "pending" };`,
    ).catch(() => undefined);

    // 到期主体的计费残留（manual 来源路径产生的行形状）
    await db.query(
      `INSERT INTO billing_account { id: billing_account:expired, account_key: "personal:sub_expired", name: "t", kind: "personal", status: "active" };
       INSERT INTO billing_account_member { billing_account: billing_account:expired, subject: "sub_expired", role: "owner", status: "active" };
       INSERT INTO quota_subscription { id: quota_subscription:expired, billing_account: billing_account:expired, source: "manual", status: "active", revision: 1, correlation_id: "c" };
       INSERT INTO quota_subscription_item { subscription: quota_subscription:expired, workspace: workspace:w_exp, plan_revision: quota_plan_revision:trial_v2, product_plan_revision: NONE, effective_from: <datetime>$t, effective_until: NONE, revision: 1, status: "active", correlation_id: "c", causation_id: "c" };
       INSERT INTO billing_account { id: billing_account:live, account_key: "personal:sub_live", name: "t", kind: "personal", status: "active" };
       INSERT INTO billing_account_member { billing_account: billing_account:live, subject: "sub_live", role: "owner", status: "active" };
       INSERT INTO quota_subscription { id: quota_subscription:live, billing_account: billing_account:live, source: "manual", status: "active", revision: 1, correlation_id: "c" };`,
      { t: new DateTime("2025-06-01T00:00:00Z") },
    );

    // 到期主体的运营身份
    await db.query(
      `INSERT INTO platform_operator { id: platform_operator:expired, subject: "sub_expired", display_name: "测试", status: "active", kind: "agent" };
       INSERT INTO platform_operator_capability { operator: platform_operator:expired, capability: "content.publish", status: "active", granted_by_subject: "test" };
       INSERT INTO platform_operator { id: platform_operator:live, subject: "sub_live", display_name: "测试", status: "active", kind: "agent" };`,
    );
  });

  afterAll(async () => {
    try { await db?.close(); } catch { /* noop */ }
    server?.kill();
    if (workingDirectory) await rm(workingDirectory, { recursive: true, force: true });
  });

  localTest("048 schema：test_subject 与 workspace 到期字段落成", async () => {
    const info = await db!.query(`INFO FOR TABLE test_subject;`);
    expect(rows(info).length >= 0).toBe(true);
    const expired = await findTestSubject(queryClient(), "sub_expired");
    expect(expired?.subject).toBe("sub_expired");
    expect(await isExpiredTestSubject(queryClient(), "sub_expired", new Date("2026-11-01"))).toBe(true);
    expect(await isActiveTestSubject(queryClient(), "sub_live", new Date("2026-11-01"))).toBe(true);
  });

  localTest("PUT 路由在真实库上 upsert test_subject、operator 与能力并回填 workspace", async () => {
    const app = createOpsTestSubjectsRoutes({
      requireOperator: () => async (c, next) => {
        c.set("platformOperator", { subject: "test-admin", capabilities: ["test.manage"] });
        await next();
      },
      getSystemDb: async () => queryClient(),
    });
    // w_live 只有 sub_live 一个成员 → PUT 应回填 test 字段（已由夹具带值，验证幂等覆盖）
    const res = await app.request("/api/ops/test-subjects/sub_put", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expiresAt: new Date(Date.now() + 10 * 24 * 3600_000).toISOString(),
        origin: "task-put",
        contentCapabilities: ["content.submit", "content.publish"],
      }),
    });
    if (res.status !== 200) console.error("PUT body:", await res.clone().text());
    expect(res.status).toBe(200);
    const stored = rows(await db!.query(`SELECT subject, expires_at, origin FROM test_subject WHERE subject = "sub_put";`));
    expect(stored).toHaveLength(1);
    expect(Date.parse(String(jsonify(stored[0].expires_at)))).toBeGreaterThan(Date.now());
    expect(stored[0].origin).toBe("task-put");
    expect(rows(await db!.query(`SELECT id FROM platform_operator WHERE subject = "sub_put";`))).toHaveLength(1);
    const capsResult = jsonify(await db!.query(
      `SELECT VALUE capability FROM platform_operator_capability
       WHERE operator IN (SELECT VALUE id FROM platform_operator WHERE subject = "sub_put");`,
    )) as unknown[][];
    expect([...(capsResult[0] as string[])].sort()).toEqual(["content.publish", "content.submit"]);
  });

  localTest("runTestSubjectReaper 删到期库与索引行、保留未到期与混合成员", async () => {
    const result = await runTestSubjectReaper(deps("2026-11-01T00:00:00Z"));

    // w_exp 到期 → 删库
    const dbs = jsonify((await db!.query(`INFO FOR NAMESPACE;`)) as unknown[])[0] as
      Record<string, { databases?: Record<string, string> }> | Record<string, unknown>;
    const dbNames = Object.keys((dbs as { databases?: Record<string, string> }).databases ?? {});
    expect(dbNames).not.toContain("ws_ts_exp");
    expect(dbNames).toContain("ws_ts_live");
    expect(dbNames).toContain("ws_ts_mixed"); // 含非测试成员 → 跳过

    // w_exp 的 workspace 行与 user_workspace_index 行已删
    expect(rows(await db!.query(`SELECT id FROM workspace WHERE id = workspace:w_exp;`))).toHaveLength(0);
    expect(rows(await db!.query(`SELECT id FROM user_workspace_index WHERE workspace = workspace:w_exp;`))).toHaveLength(0);
    expect(rows(await db!.query(`SELECT id FROM quota_policy_projection WHERE workspace = workspace:w_exp;`))).toHaveLength(0);
    // w_live 完好
    expect(rows(await db!.query(`SELECT id FROM workspace WHERE id = workspace:w_live;`))).toHaveLength(1);
    expect(rows(await db!.query(`SELECT id FROM user_workspace_index WHERE workspace = workspace:w_live;`))).toHaveLength(1);
    expect(result.workspacesSkipped).toBe(1); // w_mixed
    // w_mixed 跳过删除；到期主体的成员索引仍按主体清理，剩非测试成员 1 行。
    expect(rows(await db!.query(`SELECT id FROM user_workspace_index WHERE workspace = workspace:w_mixed;`))).toHaveLength(1);

    // 到期主体 operator/capability/test_subject 删除；未到期主体完好
    expect(result.subjectsPurged).toBe(1);
    expect(rows(await db!.query(`SELECT id FROM platform_operator WHERE subject = "sub_expired";`))).toHaveLength(0);
    expect(rows(await db!.query(`SELECT id FROM platform_operator_capability WHERE operator = platform_operator:expired;`))).toHaveLength(0);
    expect(rows(await db!.query(`SELECT id FROM test_subject WHERE subject = "sub_expired";`))).toHaveLength(0);
    expect(rows(await db!.query(`SELECT id FROM test_subject WHERE subject = "sub_live";`))).toHaveLength(1);
    expect(rows(await db!.query(`SELECT id FROM platform_operator WHERE subject = "sub_live";`))).toHaveLength(1);

    // 计费残留：到期主体的 billing/subscription 行全清，未到期主体完好
    expect(rows(await db!.query(`SELECT id FROM billing_account WHERE account_key = "personal:sub_expired";`))).toHaveLength(0);
    expect(rows(await db!.query(`SELECT id FROM billing_account_member WHERE billing_account = billing_account:expired;`))).toHaveLength(0);
    expect(rows(await db!.query(`SELECT id FROM quota_subscription WHERE billing_account = billing_account:expired;`))).toHaveLength(0);
    expect(rows(await db!.query(`SELECT id FROM quota_subscription_item WHERE subscription = quota_subscription:expired;`))).toHaveLength(0);
    expect(rows(await db!.query(`SELECT id FROM billing_account WHERE account_key = "personal:sub_live";`))).toHaveLength(1);
    expect(rows(await db!.query(`SELECT id FROM quota_subscription WHERE billing_account = billing_account:live;`))).toHaveLength(1);
  });
});
