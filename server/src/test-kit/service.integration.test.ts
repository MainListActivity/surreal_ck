// 真实 fork SurrealDB + 真实 InviteService/SurrealInviteAuditStore 上验证测试物料自助。
// 只替身外部依赖：IdP、建库器、产品权益与 AI 额度；登记、对账、续跑、清理与 reaper 全部真实执行。
// 逐条复现评审场景：续跑时 IdP 报复用、跨日续跑、建出用户后失败、同步窗完成后登记失败、
// 加入他人测试 workspace 后清理、清理后不复活、未登录成员（subject = NONE）不拖住 reaper。
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Surreal, jsonify } from "surrealdb";

import { InviteService } from "../invitations/invite-service";
import { SurrealInviteAuditStore } from "../invitations/invite-store";
import type { Queryable } from "../test-subjects/store";
import { purgeTestWorkspace } from "../test-subjects/reaper";
import { TestKitService, type TestKitActor } from "./service";

const RUN_INTEGRATION = process.env.RUN_LOCAL_SURREALDB_TEST_SUBJECT_TESTS === "1";
const localTest = test.skipIf(!RUN_INTEGRATION);
const surrealBinary = process.env.SURREAL_BINARY ?? "surreal";

const AGENT: TestKitActor = { subject: "agent-arch", kind: "agent", capabilities: ["test.provision"] };
const OTHER_AGENT: TestKitActor = { subject: "agent-other", kind: "agent", capabilities: ["test.provision"] };
const A = "7e183d2f-0000-4000-8000-00000000000a";
const DAY = 86_400_000;

let endpoint = "";
let workingDirectory = "";
let server: ReturnType<typeof Bun.spawn> | undefined;
let db: Surreal | undefined;

// ---- 外部依赖替身 ----
const idpUsers = new Map<string, { id: string; email: string; displayName: string; status: string }>();
let assignBehaviour: "ok" | "hang" | "fail" = "ok";
let clockOffset = 0;

function rows(result: unknown): Record<string, unknown>[] {
  const value = Array.isArray(result) ? jsonify(result[0]) : undefined;
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  return typeof value === "object" && value !== null ? [value as Record<string, unknown>] : [];
}
const q = async (sql: string, params?: Record<string, unknown>) => rows(await db!.query(sql, params));
const queryClient = (): Queryable => ({ query: async (sql, params) => await db!.query(sql, params) });

const fakeIdp = {
  async ensureUser(input: { email: string; displayName: string }) {
    const email = input.email.toLowerCase();
    const existing = idpUsers.get(email);
    if (existing) return { user: existing, created: false, activationUrl: null };
    const user = { id: `sub-${email.split("+")[1]!.split("@")[0]}`, email, displayName: input.displayName, status: "pending" };
    idpUsers.set(email, user);
    return { user, created: true, activationUrl: `https://auth.example/activate/${user.id}` };
  },
  async findUserByEmail(email: string) { return idpUsers.get(email.toLowerCase()) ?? null; },
};

function inviteService(opts: { syncWindowMs?: number; staleProcessingMs?: number } = {}) {
  return new InviteService({
    idp: async () => fakeIdp as never,
    workspaceCreator: {
      async createWorkspace(input: { subject: string; email: string; slug: string; name: string }) {
        const taken = await q(`SELECT owner_subject FROM workspace WHERE slug = $slug;`, { slug: input.slug });
        if (taken.length > 0) return { kind: "slug-conflict" };
        const dbName = `ws_${input.slug.replaceAll("-", "_")}`;
        await db!.query(
          `CREATE workspace CONTENT { slug: $slug, name: $name, db_name: $dbName, owner_subject: $subject, status: "active" };
           INSERT INTO user_workspace_index { subject: $subject, email: $email, workspace: (SELECT VALUE id FROM ONLY workspace WHERE slug = $slug LIMIT 1), db_name: $dbName, role: "admin" };
           DEFINE DATABASE IF NOT EXISTS ${dbName};`,
          { slug: input.slug, name: input.name, dbName, subject: input.subject, email: input.email },
        );
        return { kind: "created", dbName };
      },
    } as never,
    products: {
      async assign() {
        if (assignBehaviour === "hang") return await new Promise<never>(() => {});
        if (assignBehaviour === "fail") throw new Error("entitlement backend down");
        return {} as never;
      },
    },
    allowance: {
      async balance() { return { buckets: [] } as never; },
      async grant() { return { bucket: null } as never; },
    },
    store: new SurrealInviteAuditStore(async () => queryClient() as never),
    defaultProductRevision: async () => "product_plan_revision:pro_trial",
    ...opts,
  });
}

function kit(invites = inviteService()) {
  return new TestKitService({
    invites,
    members: {
      // 与真实 MemberManager 一致：预加入成员的索引行 subject 为 NONE，首次登录才按邮箱回填。
      async addMember(input) {
        await db!.query(
          `INSERT INTO user_workspace_index { subject: NONE, email: $email, workspace: (SELECT VALUE id FROM ONLY workspace WHERE slug = $slug LIMIT 1), db_name: (SELECT VALUE db_name FROM ONLY workspace WHERE slug = $slug LIMIT 1), role: "participant" };`,
          { email: input.email, slug: input.slug },
        );
        return { kind: "added" };
      },
    },
    getSystemDb: async () => queryClient(),
    idpFindUser: async (email) => { const u = await fakeIdp.findUserByEmail(email); return u ? { id: u.id } : null; },
    reaperDeps: async () => ({
      systemDb: queryClient(),
      dropDatabase: async (name: string) => { await db!.query(`REMOVE DATABASE IF EXISTS ${name};`); },
      log: () => {},
    }),
    emailPattern: "kit[+][a-z0-9-]+@example[.]com",
    maxActive: 5,
    now: () => new Date(Date.now() + clockOffset),
  });
}

const provisionArgs = (name: string) => ({ email: `kit+${name}@example.com`, displayName: name, workspaceSlug: `kit-${name}` });
const subjectRow = async (subject: string) => (await q(`SELECT origin, expires_at FROM test_subject WHERE subject = $subject;`, { subject }))[0];
const databases = async () => Object.keys(((await q(`INFO FOR NS;`))[0]?.databases ?? {}) as Record<string, unknown>);
const codeOf = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string }) => error.code ?? String(error));

describe("test kit on real fork SurrealDB with the real invite service", () => {
  beforeAll(async () => {
    if (!RUN_INTEGRATION) return;
    workingDirectory = await mkdtemp(join(tmpdir(), "surreal-ck-test-kit-"));
    const port = await (async () => await new Promise<number>((resolve, reject) => {
      const listener = createServer();
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => {
        const address = listener.address();
        if (!address || typeof address === "string") { listener.close(); reject(new Error("no port")); return; }
        listener.close((error) => (error ? reject(error) : resolve(address.port)));
      });
    }))();
    endpoint = `ws://127.0.0.1:${port}`;
    server = Bun.spawn(
      [surrealBinary, "start", "--no-banner", "--log", "none", "--bind", `127.0.0.1:${port}`,
        "--user", "root", "--pass", "root", `rocksdb:${join(workingDirectory, "data")}`],
      { cwd: workingDirectory, stdout: "ignore", stderr: "ignore" },
    );
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const probe = Bun.spawn([surrealBinary, "is-ready", "--endpoint", endpoint], { stdout: "ignore", stderr: "ignore" });
      if ((await probe.exited) === 0) break;
      await Bun.sleep(100);
    }
    db = new Surreal();
    await db.connect(`${endpoint}/rpc`, { authentication: { username: "root", password: "root" } });
    await db.use({ namespace: "main", database: "_system" });
    const migrationsUrl = new URL("../../../shared/sql/system/", import.meta.url);
    for (const migration of (await readdir(migrationsUrl)).filter((e) => /^\d{3}-.+\.surql$/u.test(e)).sort()) {
      await db.query(await readFile(new URL(migration, migrationsUrl), "utf8"));
    }
    // 运营登记的测试账号 A 与其测试 workspace（signal-test-1113 的形状）
    await db.query(`
      INSERT INTO workspace { id: workspace:a, slug: "signal-test-a", name: "A", db_name: "ws_signal_test_a", owner_subject: "${A}", status: "active", test_expires_at: <datetime>$exp };
      INSERT INTO user_workspace_index { subject: "${A}", email: "ops-a@example.com", workspace: workspace:a, db_name: "ws_signal_test_a", role: "admin" };
      INSERT INTO test_subject { subject: "${A}", email: "ops-a@example.com", expires_at: <datetime>$exp, origin: "ops" };
      DEFINE DATABASE ws_signal_test_a;
    `, { exp: new DateTime(new Date(Date.now() + 20 * DAY)) });
  });

  afterAll(async () => {
    try { await db?.close(); } catch { /* noop */ }
    server?.kill();
    if (workingDirectory) await rm(workingDirectory, { recursive: true, force: true });
  });

  beforeEach(() => { assignBehaviour = "ok"; clockOffset = 0; });

  localTest("049：test.provision 能力可写入，开通行带清理标记字段", async () => {
    await db!.query(`
      INSERT INTO platform_operator { subject: "agent-arch", display_name: "测试物料 agent", status: "active", kind: "agent" };
      INSERT INTO platform_operator_capability { operator: (SELECT VALUE id FROM ONLY platform_operator WHERE subject = "agent-arch" LIMIT 1), capability: "test.provision", status: "active", granted_by_subject: "t" };
    `);
    expect((await q(`SELECT VALUE capability FROM platform_operator_capability;`)) as unknown[]).toContain("test.provision");
  });

  localTest("开通：登记 30 天测试主体、标记 workspace、一次性链接；同邮箱重复调用幂等", async () => {
    const out = await kit().provision(AGENT, provisionArgs("b")) as Record<string, unknown>;
    expect(out).toMatchObject({ status: "completed", subject: "sub-b", activationUrl: "https://auth.example/activate/sub-b" });
    expect((await subjectRow("sub-b"))?.origin).toBe("test-kit:agent-arch");
    expect((await q(`SELECT test_origin FROM workspace WHERE slug = "kit-b";`))[0]?.test_origin).toBe("test-kit:agent-arch");
    const again = await kit().provision(AGENT, provisionArgs("b")) as Record<string, unknown>;
    expect(again).toMatchObject({ status: "completed", subject: "sub-b", activationUrl: null });
    expect(await q(`SELECT * FROM ops_invitation WHERE email = "kit+b@example.com";`)).toHaveLength(1);
  });

  localTest("续跑：首轮建出用户后中断，跨两天后 status 续跑 → IdP 报复用仍登记，到期锚定开通行创建时刻", async () => {
    assignBehaviour = "hang";
    const first = await kit(inviteService({ syncWindowMs: 50 })).provision(AGENT, provisionArgs("resume")) as Record<string, unknown>;
    expect(first.status).toBe("processing");
    expect(idpUsers.has("kit+resume@example.com")).toBe(true);
    expect((await kit().list(AGENT)).inFlight.map((r) => r.email)).toEqual(["kit+resume@example.com"]);

    assignBehaviour = "ok";
    clockOffset = 2 * DAY;
    const resumed = await kit(inviteService({ staleProcessingMs: 0 })).status(AGENT, { email: "kit+resume@example.com" }) as Record<string, unknown>;
    expect(resumed).toMatchObject({ status: "completed", subject: "sub-resume" });
    const created = (await q(`SELECT VALUE created_at FROM ops_invitation WHERE email = "kit+resume@example.com";`))[0];
    const expires = (await subjectRow("sub-resume"))?.expires_at;
    expect(Date.parse(String(expires)) - Date.parse(String(created))).toBe(30 * DAY);
  });

  localTest("建出用户后失败：status=failed，但账号被登记交给 reaper，邮箱作废", async () => {
    assignBehaviour = "fail";
    const out = await kit().provision(AGENT, provisionArgs("broken")) as Record<string, unknown>;
    expect(out.status).toBe("failed");
    expect((await subjectRow("sub-broken"))?.origin).toBe("test-kit:agent-arch");
    expect((await q(`SELECT test_expires_at FROM workspace WHERE slug = "kit-broken";`))[0]?.test_expires_at).toBeTruthy();
    assignBehaviour = "ok";
    expect((await kit().provision(AGENT, provisionArgs("broken")) as Record<string, unknown>).status).toBe("failed");
  });

  localTest("同步窗内完成后登记失败：仍返回一次性链接，下次 list 补登记", async () => {
    await db!.query(`INSERT INTO platform_operator { subject: "sub-blocked", display_name: "x", status: "active", kind: "human" };`);
    const out = await kit().provision(AGENT, provisionArgs("blocked")) as Record<string, unknown>;
    expect(out).toMatchObject({ status: "completed", registered: false, activationUrl: "https://auth.example/activate/sub-blocked" });
    expect(await subjectRow("sub-blocked")).toBeUndefined();
    await db!.query(`DELETE platform_operator WHERE subject = "sub-blocked";`);
    expect((await kit().list(AGENT)).subjects.map((s) => s.subject)).toContain("sub-blocked");
  });

  localTest("加入运营账号 A 的 workspace（未登录 NONE 行）；清理 B 只删 B 的库，A 的库与成员保留", async () => {
    expect(await codeOf(kit().addMember(AGENT, { workspaceSlug: "signal-test-a", email: "kit+b@example.com", isAdmin: true }))).toBe("not_owned");
    expect(await kit().addMember(AGENT, { workspaceSlug: "signal-test-a", email: "kit+b@example.com" })).toMatchObject({ added: true });
    // B 未登录时 A 的 workspace 不因 NONE 行被当作外部成员
    expect(await codeOf(kit().addMember(OTHER_AGENT, { workspaceSlug: "kit-b", email: "kit+b@example.com" }))).toBe("not_owned");

    const out = await kit().purge(AGENT, { subject: "sub-b", confirm: "purge sub-b" });
    expect(out).toMatchObject({ workspacesPurged: 1, workspacesSkipped: 0 });
    expect(await databases()).toContain("ws_signal_test_a");
    expect(await databases()).not.toContain("ws_kit_b");
    expect(await q(`SELECT * FROM user_workspace_index WHERE workspace = workspace:a AND subject = NONE;`)).toEqual([]);
  });

  localTest("清理后不复活：list 不补登记，同邮箱再开通被拒", async () => {
    expect((await kit().list(AGENT)).subjects.map((s) => s.subject)).not.toContain("sub-b");
    expect(await subjectRow("sub-b")).toBeUndefined();
    // 开通行随库清理被删时由 IdP 查重拒绝；库被跳过、行仍在时由清理标记拒绝。两种都不会复活。
    expect(["purged", "email_in_use"]).toContain(await codeOf(kit().provision(AGENT, provisionArgs("b"))));
  });

  localTest("reaper：成员只有测试主体与其未登录 NONE 行时照常删库", async () => {
    await kit().provision(AGENT, provisionArgs("owner"));
    await kit().provision(AGENT, provisionArgs("guest"));
    await kit().addMember(AGENT, { workspaceSlug: "kit-owner", email: "kit+guest@example.com" });
    const wid = String((await q(`SELECT VALUE id FROM workspace WHERE slug = "kit-owner";`))[0]);
    expect(await purgeTestWorkspace({ systemDb: queryClient(), dropDatabase: async (n) => { await db!.query(`REMOVE DATABASE IF EXISTS ${n};`); }, log: () => {} }, wid)).toBe("purged");
    expect(await databases()).not.toContain("ws_kit_owner");
  });

  localTest("开通中计入上限；已清理与他人账号不计入", async () => {
    const active = (await kit().list(AGENT));
    const open = active.subjects.filter((s) => !s.expired).length + active.inFlight.length;
    for (let n = open; n < 5; n += 1) await kit().provision(AGENT, provisionArgs(`fill${n}`));
    expect(await codeOf(kit().provision(AGENT, provisionArgs("over")))).toBe("limit_reached");
  });
});
