// 真实 fork SurrealDB 上验证：UUID 形 subject（生产 IdP sub = crypto.randomUUID()）
// 经 SDK 参数传入时，store / 预检 / 路由的 `subject = $subject` 仍精确命中字符串字段，
// 且预检与 PUT 的确认/拒绝门真实生效。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Surreal, jsonify } from "surrealdb";

import { createOpsTestSubjectsRoutes } from "../routes/ops-test-subjects";
import { computeTestSubjectPreflight, lookupSubjectsByEmail } from "./preflight";
import { findTestSubject, isActiveTestSubject } from "./store";

const RUN_INTEGRATION = process.env.RUN_LOCAL_SURREALDB_TEST_SUBJECT_TESTS === "1";
const localTest = test.skipIf(!RUN_INTEGRATION);
const surrealBinary = process.env.SURREAL_BINARY ?? "surreal";

// 小写 UUID（IdP 实际形状）与一个大写 UUID（若 JSON-RPC/SDK 把参数强转 uuid 会被小写化而失配）。
const SOLE = "3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c";
const OWNER = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const OTHER = "0c9b8a7f-6e5d-4c3b-9a21-f0e9d8c7b6a5";
const OPERATOR = "9e8d7c6b-5a49-4382-a716-1f2e3d4c5b6a";
const UPPER = "7D1E2F3A-4B5C-4D6E-8F70-A1B2C3D4E5F6";

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
  return { query: async (sql: string, params?: Record<string, unknown>) => await db!.query(sql, params) };
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
    const probe = Bun.spawn([surrealBinary, "is-ready", "--endpoint", endpoint], { stdout: "ignore", stderr: "ignore" });
    if ((await probe.exited) === 0) return;
    await Bun.sleep(100);
  }
  throw new Error("local SurrealDB did not become ready");
}

function app() {
  return createOpsTestSubjectsRoutes({
    requireOperator: () => async (c, next) => {
      c.set("platformOperator", { subject: "test-admin", capabilities: ["test.manage"] });
      await next();
    },
    getSystemDb: async () => queryClient(),
    dropDatabase: async (dbName) => { await db!.query(`REMOVE DATABASE IF EXISTS ${dbName};`); },
    workspaceCreator: {
      async createWorkspace(input) {
        await db!.query(
          `CREATE workspace CONTENT { slug: $slug, name: $name, db_name: $dbName, owner_subject: $subject, status: "active", test_expires_at: (SELECT VALUE expires_at FROM ONLY test_subject WHERE subject = $subject LIMIT 1) };
           INSERT INTO user_workspace_index { subject: $subject, email: NONE, workspace: (SELECT VALUE id FROM ONLY workspace WHERE slug = $slug LIMIT 1), db_name: $dbName, role: "admin" };`,
          { slug: input.slug, name: input.name, dbName: `ws_${input.slug.replaceAll("-", "_")}`, subject: input.subject },
        );
        return { kind: "created", dbName: `ws_${input.slug.replaceAll("-", "_")}` } as never;
      },
    } as never,
  });
}

const json = (body: unknown) => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const inTenDays = () => new Date(Date.now() + 10 * 24 * 3600_000).toISOString();

describe("test-subject preflight & routes with UUID subjects on real fork SurrealDB", () => {
  beforeAll(async () => {
    if (!RUN_INTEGRATION) return;
    workingDirectory = await mkdtemp(join(tmpdir(), "surreal-ck-test-subject-uuid-"));
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
    // 字符串字段里存 UUID 形 subject：全部用 SurrealQL 字符串字面量写入，避免夹具本身被强转。
    await db.query(`
      INSERT INTO workspace [
        { id: workspace:sole, slug: "member-solo", name: "Solo", db_name: "ws_member_solo", owner_subject: "${SOLE}", status: "active" },
        { id: workspace:shared, slug: "team-shared", name: "Team", db_name: "ws_team_shared", owner_subject: "${OWNER}", status: "active" }
      ];
      INSERT INTO user_workspace_index [
        { subject: "${SOLE}", email: "Member@Example.com", workspace: workspace:sole, db_name: "ws_member_solo", role: "admin" },
        { subject: "${OWNER}", email: "owner@example.com", workspace: workspace:shared, db_name: "ws_team_shared", role: "admin" },
        { subject: "${SOLE}", email: "Member@Example.com", workspace: workspace:shared, db_name: "ws_team_shared", role: "participant" },
        { subject: "${OTHER}", email: "other@example.com", workspace: workspace:shared, db_name: "ws_team_shared", role: "participant" }
      ];
      INSERT INTO platform_operator { subject: "${OPERATOR}", display_name: "op", status: "active", kind: "human" };
      INSERT INTO test_subject { subject: "${UPPER}", email: NONE, expires_at: <datetime>$live, origin: "upper" };
    `, { live: new DateTime(new Date(Date.now() + 5 * 24 * 3600_000)) });
    for (const name of ["ws_member_solo", "ws_team_shared"]) await db.query(`DEFINE DATABASE ${name};`);
  });

  afterAll(async () => {
    try { await db?.close(); } catch { /* noop */ }
    server?.kill();
    if (workingDirectory) await rm(workingDirectory, { recursive: true, force: true });
  });

  localTest("store 按 UUID subject（含大写）精确命中字符串字段", async () => {
    const upper = await findTestSubject(queryClient(), UPPER);
    expect(upper?.subject).toBe(UPPER);
    expect(await isActiveTestSubject(queryClient(), UPPER)).toBe(true);
    expect(await findTestSubject(queryClient(), UPPER.toLowerCase())).toBeNull();
  });

  localTest("预检列出单成员/共享工作区、成员数与标记后果，且只读", async () => {
    const preflight = await computeTestSubjectPreflight(queryClient(), SOLE);
    expect(preflight.blockers).toEqual([]);
    expect(preflight.testSubject).toBeNull();
    expect(preflight.workspaces.map((w) => [w.slug, w.memberCount, w.role, w.wouldBeMarked, w.newlyMarked, w.membershipRemovedOnExpiry]))
      .toEqual([
        ["member-solo", 1, "admin", true, true, false],
        ["team-shared", 3, "participant", false, false, true],
      ]);
    expect(preflight.requiresConfirmation).toBe(true);
    expect(preflight.confirmationPhrase).toBe(`确认到期清理 ${SOLE}`);
    expect(rows(await db!.query(`SELECT test_expires_at FROM workspace:sole;`))[0]?.test_expires_at).toBeUndefined();
  });

  localTest("预检硬拒绝：共享工作区 owner/admin 与正式运营主体", async () => {
    const owner = await computeTestSubjectPreflight(queryClient(), OWNER);
    expect(owner.blockers.map((b) => b.code)).toEqual(["shared-workspace-admin"]);
    const operator = await computeTestSubjectPreflight(queryClient(), OPERATOR);
    expect(operator.blockers.map((b) => b.code)).toEqual(["active-platform-operator"]);
    const http = await app().request(`/api/ops/test-subjects/${OPERATOR}/preflight`);
    expect(http.status).toBe(200);
    expect((await http.json()).blockers[0].code).toBe("active-platform-operator");
  });

  localTest("PUT：拒绝门不写库；原样确认后登记 UUID subject 并只标记单成员工作区", async () => {
    for (const subject of [OWNER, OPERATOR]) {
      const res = await app().request(`/api/ops/test-subjects/${subject}`, json({ expiresAt: inTenDays(), confirm: `确认到期清理 ${subject}` }));
      expect(res.status).toBe(409);
    }
    const refused = await app().request(`/api/ops/test-subjects/${SOLE}`, json({ expiresAt: inTenDays(), email: "member@example.com" }));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe("test-subject-confirmation-required");
    expect(rows(await db!.query(`SELECT id FROM test_subject WHERE subject IN ["${SOLE}", "${OWNER}", "${OPERATOR}"];`))).toHaveLength(0);

    const ok = await app().request(`/api/ops/test-subjects/${SOLE}`, json({
      expiresAt: inTenDays(), email: "member@example.com", origin: "native-chat", confirm: `确认到期清理 ${SOLE}`,
    }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).subject).toBe(SOLE);
    const stored = rows(await db!.query(`SELECT subject, type::is_string(subject) AS str FROM test_subject WHERE subject = "${SOLE}";`));
    expect(stored).toEqual([{ subject: SOLE, str: true }]);
    expect(rows(await db!.query(`SELECT test_expires_at FROM workspace:sole;`))[0]?.test_expires_at).toBeDefined();
    expect(rows(await db!.query(`SELECT test_expires_at FROM workspace:shared;`))[0]?.test_expires_at).toBeUndefined();

    // 已登记后再次预检：已标记的工作区不再算「新标记」，但共享成员索引警告仍需确认。
    const again = await computeTestSubjectPreflight(queryClient(), SOLE);
    expect(again.testSubject?.email).toBe("member@example.com");
    expect(again.workspaces.find((w) => w.slug === "member-solo")?.newlyMarked).toBe(false);
    expect(again.requiresConfirmation).toBe(true);
  });

  localTest("GET 列表、email 查找与新建测试工作区对 UUID subject 生效", async () => {
    const list = await (await app().request(`/api/ops/test-subjects`)).json();
    const entry = list.subjects.find((s: { subject: string }) => s.subject === SOLE);
    expect([...entry.workspaces].sort()).toEqual(["member-solo", "team-shared"]);

    const found = await lookupSubjectsByEmail(queryClient(), "MEMBER@example.com");
    expect(found.map((f) => [f.subject, f.testSubject, f.workspaces.length])).toEqual([[SOLE, true, 2]]);
    const http = await app().request(`/api/ops/test-subjects/lookup?email=${encodeURIComponent("member@example.com")}`);
    expect((await http.json()).subjects[0].subject).toBe(SOLE);

    const created = await app().request(`/api/ops/test-subjects/${SOLE}/workspaces`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: "member-chat-test", name: "Chat Test" }),
    });
    expect(created.status).toBe(201);
    expect((await created.json()).testExpiresAt).not.toBeNull();
    const again = await app().request(`/api/ops/test-subjects/${SOLE}/workspaces`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: "member-chat-test", name: "Chat Test" }),
    });
    expect(again.status).toBe(200);
  });

  localTest("DELETE 按 UUID subject 清除：单成员工作区删库，共享工作区保留", async () => {
    const res = await app().request(`/api/ops/test-subjects/${SOLE}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(rows(await db!.query(`SELECT id FROM test_subject WHERE subject = "${SOLE}";`))).toHaveLength(0);
    expect(rows(await db!.query(`SELECT id FROM workspace WHERE slug IN ["member-solo", "member-chat-test"];`))).toHaveLength(0);
    expect(rows(await db!.query(`SELECT id FROM workspace:shared;`))).toHaveLength(1);
    expect(rows(await db!.query(`SELECT subject FROM user_workspace_index WHERE workspace = workspace:shared;`)).map((r) => r.subject).sort())
      .toEqual([OWNER, OTHER].sort());
  });
});
