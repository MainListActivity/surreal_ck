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

import { createNativeMeetingBatchRunner, sweepNativeMeetingWorkspaces } from "../db/native-meeting-gc";
import { InviteService } from "../invitations/invite-service";
import { SurrealInviteAuditStore } from "../invitations/invite-store";
import { SurrealProductEntitlementStore } from "../product-entitlement/store";
import { stableSha256 } from "../quota/canonical";
import type { Queryable } from "../test-subjects/store";
import { purgeTestWorkspace, runFailedTestKitInvitationReaper } from "../test-subjects/reaper";
import { TestKitService, type TestKitActor, type TestKitDeps } from "./service";

const RUN_INTEGRATION = process.env.RUN_LOCAL_SURREALDB_TEST_SUBJECT_TESTS === "1";
const localTest = test.skipIf(!RUN_INTEGRATION);
const surrealBinary = process.env.SURREAL_BINARY ?? "surreal";
const testTiKV = process.env.SURREAL_TEST_KIT_TIKV === "1";

const AGENT: TestKitActor = { subject: "agent-arch", kind: "agent", capabilities: ["test.provision"] };
const OTHER_AGENT: TestKitActor = { subject: "agent-other", kind: "agent", capabilities: ["test.provision"] };
const A = "7e183d2f-0000-4000-8000-00000000000a";
const DAY = 86_400_000;
const MAX_ACTIVE = 10;

let endpoint = "";
let workingDirectory = "";
let server: ReturnType<typeof Bun.spawn> | undefined;
let db: Surreal | undefined;

// ---- 外部依赖替身 ----
const idpUsers = new Map<string, { id: string; email: string; displayName: string; status: string }>();
const cancellationProofs = new Map<string, string>();
let assignBehaviour: "ok" | "hang" | "fail" | "conflict" = "ok";
let clockOffset = 0;

function rows(result: unknown): Record<string, unknown>[] {
  const value = Array.isArray(result) ? jsonify(result[0]) : undefined;
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  return typeof value === "object" && value !== null ? [value as Record<string, unknown>] : [];
}
const q = async (sql: string, params?: Record<string, unknown>) => rows(await db!.query(sql, params));
const queryClient = (): Queryable => ({ query: async (sql, params) => await db!.query(sql, params) });

const fakeIdp = {
  async ensureUser(input: { email: string; displayName: string; cancellationToken?: string }) {
    const email = input.email.toLowerCase();
    const existing = idpUsers.get(email);
    if (existing) return { user: existing, created: false, activationUrl: null };
    const user = { id: `sub-${email.split("+")[1]!.split("@")[0]}`, email, displayName: input.displayName, status: "pending" };
    idpUsers.set(email, user);
    if (input.cancellationToken) cancellationProofs.set(input.cancellationToken, email);
    return { user, created: true, activationUrl: `https://auth.example/activate/${user.id}` };
  },
  async findUserByEmail(email: string) { return idpUsers.get(email.toLowerCase()) ?? null; },
  async cancelProvision(token: string) {
    const email = cancellationProofs.get(token);
    if (email) idpUsers.delete(email);
    cancellationProofs.delete(token);
  },
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
      async assign(actor, input) {
        if (assignBehaviour === "hang") return await new Promise<never>(() => {});
        if (assignBehaviour === "fail") throw new Error("entitlement backend down");
        if (assignBehaviour === "conflict") {
          const store = new SurrealProductEntitlementStore(async () => ({
            async query(sql, params) {
              if (assignBehaviour === "conflict") {
                assignBehaviour = "ok";
                throw { kind: "Quota", details: { code: "quota_conflict", retryable: true, details: {} } };
              }
              return await db!.query(sql, params);
            },
          }));
          const [workspace] = await q("SELECT id FROM workspace WHERE slug = $slug;", { slug: input.workspaceSlug });
          expect(await store.insertAudit({
            actor: actor.subject, action: "assign", idempotencyKey: input.idempotencyKey,
            reason: input.reason, requestDigest: stableSha256(input.idempotencyKey),
            workspaceId: String(workspace?.id), entitlementId: null, productPlanRevisionId: null,
          })).toBe("ok");
        }
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

function kit(invites: TestKitDeps["invites"] = inviteService(), getSystemDb: TestKitDeps["getSystemDb"] = async () => queryClient()) {
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
    getSystemDb,
    idpFindUser: async (email) => { const u = await fakeIdp.findUserByEmail(email); return u ? { id: u.id } : null; },
    reaperDeps: async () => ({
      systemDb: queryClient(),
      dropDatabase: async (name: string) => { await db!.query(`REMOVE DATABASE IF EXISTS ${name};`); },
      cancelIdpProvision: fakeIdp.cancelProvision,
      log: () => {},
    }),
    emailPattern: "kit[+][a-z0-9-]+@example[.]com",
    maxActive: MAX_ACTIVE,
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
    if (testTiKV) {
      const capability = await fetch("http://127.0.0.1:18000/capabilities", { redirect: "error" });
      if (!capability.ok) throw new Error("TiKV candidate is not reachable");
      const { storage } = await capability.json() as { storage?: { backend?: string; ready?: boolean } };
      if (storage?.backend !== "tikv" || storage.ready !== true) throw new Error("Expected a ready TiKV candidate");
      endpoint = "ws://127.0.0.1:18000";
    } else {
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
        { cwd: workingDirectory, stdout: "ignore", stderr: "inherit" },
      );
      for (let attempt = 0; ; attempt += 1) {
        const ready = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
          .then((response) => response.ok, () => false);
        if (ready) break;
        if (server.exitCode !== null || attempt === 29) throw new Error("RocksDB fixture did not start");
        await Bun.sleep(1000);
      }
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
  }, 180_000);

  afterAll(async () => {
    try { await db?.close(); } catch { /* noop */ }
    if (server) {
      server.kill();
      await server.exited;
    }
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
    const invites = inviteService();
    const out = await kit({
      provision: invites.provision.bind(invites),
      get: invites.get.bind(invites),
      async collect(key, options) {
        expect(await invites.collect(key)).toBeNull();
        expect(await invites.resend({ subject: "operator", capabilities: ["subscription.manage"] }, key)).toBeNull();
        return invites.collect(key, options);
      },
    }).provision(AGENT, provisionArgs("b"));
    expect(out).toMatchObject({ status: "completed", subject: "sub-b", activationUrl: "https://auth.example/activate/sub-b" });
    expect((await subjectRow("sub-b"))?.origin).toBe("test-kit:agent-arch");
    expect((await q(`SELECT test_origin FROM workspace WHERE slug = "kit-b";`))[0]?.test_origin).toBe("test-kit:agent-arch");
    const again = await kit().provision(AGENT, provisionArgs("b")) as Record<string, unknown>;
    expect(again).toMatchObject({ status: "completed", subject: "sub-b", activationUrl: null });
    expect(await q(`SELECT * FROM ops_invitation WHERE email = "kit+b@example.com";`)).toHaveLength(1);
  });

  localTest("旧版开通中断：超过阈值后 status 收养已建出的用户", async () => {
    assignBehaviour = "hang";
    const first = await kit(inviteService({ syncWindowMs: 50 })).provision(AGENT, provisionArgs("stuck")) as Record<string, unknown>;
    expect(first.status).toBe("processing");
    expect((await kit().list(AGENT)).inFlight.map((r) => r.email)).toEqual(["kit+stuck@example.com"]);
    expect((await q(`SELECT VALUE idp_user_id FROM ops_invitation WHERE email = "kit+stuck@example.com";`))[0]).toBe("sub-stuck");
    await db!.query(`UPDATE ops_invitation SET test_kit_managed = NONE WHERE email = "kit+stuck@example.com";`);

    assignBehaviour = "ok";
    clockOffset = 2 * DAY;
    const out = await kit().status(AGENT, { email: "kit+stuck@example.com" }) as Record<string, unknown>;
    expect(out.status).toBe("failed");
    const created = (await q(`SELECT VALUE created_at FROM ops_invitation WHERE email = "kit+stuck@example.com";`))[0];
    const expires = (await subjectRow("sub-stuck"))?.expires_at;
    expect((await subjectRow("sub-stuck"))?.origin).toBe("test-kit:agent-arch");
    expect(Date.parse(String(expires)) - Date.parse(String(created))).toBe(30 * DAY);
    expect((await q(`SELECT test_expires_at FROM workspace WHERE slug = "kit-stuck";`))[0]?.test_expires_at).toBeTruthy();
    expect((await kit().list(AGENT)).inFlight).toEqual([]);
  });

  localTest("仍在运行的开通不因超过阈值而被清理，可以正常完成", async () => {
    let release: () => void = () => {};
    assignBehaviour = "ok";
    const slow = inviteService({ syncWindowMs: 50 });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // 让工作区创建卡在门上：先过同步窗返回 processing
    const original = (slow as unknown as { deps: { workspaceCreator: { createWorkspace: (i: unknown) => Promise<unknown> } } }).deps.workspaceCreator;
    const create = original.createWorkspace.bind(original);
    original.createWorkspace = async (input) => { await gate; return create(input); };
    expect((await kit(slow).provision(AGENT, provisionArgs("late")) as Record<string, unknown>).status).toBe("processing");

    clockOffset = 2 * DAY;
    await runFailedTestKitInvitationReaper({
      systemDb: queryClient(),
      dropDatabase: async () => { throw new Error("fixture cleanup must not run"); },
      cancelIdpProvision: fakeIdp.cancelProvision,
      now: () => new Date(Date.now() + clockOffset),
    });
    expect(await kit().status(AGENT, { email: "kit+late@example.com" })).toMatchObject({ status: "processing", activationUrl: null });
    expect(await subjectRow("sub-late")).toBeUndefined();

    release();
    for (let i = 0; i < 50 && (await q(`SELECT VALUE status FROM ops_invitation WHERE email = "kit+late@example.com";`))[0] !== "completed"; i += 1) await Bun.sleep(50);
    const after = await kit().status(AGENT, { email: "kit+late@example.com" }) as Record<string, unknown>;
    expect(after).toMatchObject({ status: "completed", activationUrl: "https://auth.example/activate/sub-late" });
    expect((await q(`SELECT test_expires_at FROM workspace WHERE slug = "kit-late";`))[0]?.test_expires_at).toBeTruthy();
  });

  localTest("进程重启遗留的过期处理中记录由 reaper 撤销，即使 IdP 用户 ID 未写回", async () => {
    const email = "kit+interrupted@example.com";
    const token = crypto.randomUUID();
    const key = `test-kit:${stableSha256(email).slice(0, 32)}`;
    const store = new SurrealInviteAuditStore(async () => queryClient() as never);
    await store.claim({
      recordId: `ops_invitation:${stableSha256(key).slice(0, 40)}`,
      idempotencyKey: key, operatorSubject: AGENT.subject, authorizedCapability: "subscription.manage",
      email, displayName: "Interrupted", workspaceSlug: "interrupted", workspaceName: "Interrupted",
      planKey: "trial", reason: "fixture", requestDigest: stableSha256("interrupted"), testKitCancellationToken: token,
    });
    await fakeIdp.ensureUser({ email, displayName: "Interrupted", cancellationToken: token });
    expect(await kit().status(AGENT, { email })).toMatchObject({ status: "processing", activationUrl: null });
    await runFailedTestKitInvitationReaper({
      systemDb: queryClient(), dropDatabase: async () => { throw new Error("no workspace to remove"); },
      cancelIdpProvision: fakeIdp.cancelProvision, now: () => new Date(Date.now() + DAY), log: () => {},
    });
    expect(await fakeIdp.findUserByEmail(email)).toBeNull();
    expect(await kit().status(AGENT, { email })).toMatchObject({ status: "failed", activationUrl: null });
  });

  localTest("收养绝不按邮箱认领：本行没建出用户（未记 idp_user_id）时，之后别人建的同邮箱用户不会被登记", async () => {
    assignBehaviour = "hang";
    await kit(inviteService({ syncWindowMs: 50 })).provision(AGENT, provisionArgs("ghost"));
    await db!.query(`UPDATE ops_invitation SET idp_user_id = NONE, test_kit_managed = NONE WHERE email = "kit+ghost@example.com";`);
    idpUsers.set("kit+ghost@example.com", { id: "real-person", email: "kit+ghost@example.com", displayName: "x", status: "active" });
    assignBehaviour = "ok";
    clockOffset = 2 * DAY;
    await kit().list(AGENT);
    expect(await subjectRow("real-person")).toBeUndefined();
  });

  localTest("同一邮箱跨 agent：先占到行的 agent 拥有它，另一个 agent 拿 not_owned 且不触发任何开通", async () => {
    const before = (await q(`SELECT VALUE slug FROM workspace;`)).length;
    expect(await codeOf(kit().provision(OTHER_AGENT, { ...provisionArgs("b"), workspaceSlug: "kit-b-other" }))).toBe("not_owned");
    expect(await codeOf(kit().status(OTHER_AGENT, { email: "kit+b@example.com" }))).toBe("not_owned");
    expect((await q(`SELECT VALUE slug FROM workspace;`)).length).toBe(before);
  });

  localTest("权益写入遭遇 quota_conflict 后自动重试，不重复开出用户或工作区", async () => {
    assignBehaviour = "conflict";
    const svc = kit();
    expect(await svc.provision(AGENT, provisionArgs("conflict"))).toMatchObject({ status: "completed", subject: "sub-conflict" });
    expect(await q(`SELECT id FROM workspace WHERE owner_subject = "sub-conflict";`)).toHaveLength(1);
    expect(await q(`SELECT id FROM product_entitlement_audit WHERE workspace = (SELECT VALUE id FROM ONLY workspace WHERE owner_subject = "sub-conflict" LIMIT 1);`)).toHaveLength(1);
    expect(await svc.purge(AGENT, { subject: "sub-conflict", confirm: "purge sub-conflict" })).toMatchObject({ workspacesPurged: 1 });
    expect(await databases()).not.toContain("ws_kit_conflict");
  });

  localTest("建出用户后失败：自动清理后才返回 failed，邮箱作废", async () => {
    assignBehaviour = "fail";
    const invites = inviteService();
    let unavailable = false;
    const svc = kit({
      async provision(...args) {
        const result = await invites.provision(...args);
        unavailable = true;
        return result;
      },
      get: invites.get.bind(invites),
      collect: invites.collect.bind(invites),
    }, async () => {
      if (unavailable) throw new Error("fixture read unavailable");
      return queryClient();
    });
    expect(await svc.provision(AGENT, provisionArgs("broken"))).toMatchObject({ status: "processing", activationUrl: null });
    unavailable = false;
    expect(await svc.status(AGENT, { email: "kit+broken@example.com" })).toMatchObject({ status: "failed", activationUrl: null });
    expect(await subjectRow("sub-broken")).toBeUndefined();
    expect(await fakeIdp.findUserByEmail("kit+broken@example.com")).toBeNull();
    expect(await q(`SELECT id FROM workspace WHERE slug = "kit-broken";`)).toEqual([]);
    expect(await databases()).not.toContain("ws_kit_broken");
    expect((await q(`SELECT activation_url, test_kit_purged_at, test_kit_cancellation_token FROM ops_invitation WHERE email = "kit+broken@example.com";`))[0]).toEqual({
      test_kit_purged_at: expect.any(String),
    });
    assignBehaviour = "ok";
    expect((await kit().provision(AGENT, provisionArgs("broken")) as Record<string, unknown>).status).toBe("failed");
  });

  localTest("同步窗之后失败且 agent 未轮询，reaper 重试清理，不改变其他账号", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const svc = kit(inviteService({ syncWindowMs: 20, ...{
      products: { async assign() { await gate; throw new Error("fixture failure"); } },
    } }));
    expect(await svc.provision(AGENT, provisionArgs("late-fail"))).toMatchObject({ status: "processing", activationUrl: null });
    release();
    for (let i = 0; i < 50 && (await q(`SELECT VALUE status FROM ops_invitation WHERE email = "kit+late-fail@example.com";`))[0] !== "failed"; i += 1) await Bun.sleep(20);
    expect(await databases()).toContain("ws_kit_late_fail");
    const deps = {
      systemDb: queryClient(),
      dropDatabase: async (name: string) => { await db!.query(`REMOVE DATABASE IF EXISTS ${name};`); },
      cancelIdpProvision: fakeIdp.cancelProvision,
      log: () => {},
    };
    await runFailedTestKitInvitationReaper({ ...deps, dropDatabase: async () => { throw new Error("fixture unavailable"); } });
    expect(await databases()).toContain("ws_kit_late_fail");
    expect(await codeOf(svc.purge(AGENT, { subject: "sub-late-fail", confirm: "purge sub-late-fail" }))).toBe("cleanup_pending");
    await runFailedTestKitInvitationReaper({ ...deps, cancelIdpProvision: async () => { throw new Error("IdP unavailable"); } });
    expect(await fakeIdp.findUserByEmail("kit+late-fail@example.com")).not.toBeNull();
    expect((await svc.list(AGENT)).inFlight).toContainEqual(expect.objectContaining({ email: "kit+late-fail@example.com" }));
    await runFailedTestKitInvitationReaper(deps);
    expect(await databases()).not.toContain("ws_kit_late_fail");
    expect(await databases()).toContain("ws_signal_test_a");
    expect(await subjectRow("sub-late-fail")).toBeUndefined();
    expect(await fakeIdp.findUserByEmail("kit+late-fail@example.com")).toBeNull();
    expect(await subjectRow(A)).toBeDefined();
    expect((await svc.list(AGENT)).inFlight.map((row) => row.email)).not.toContain("kit+late-fail@example.com");
    expect(await svc.status(AGENT, { email: "kit+late-fail@example.com" })).toMatchObject({ status: "failed", activationUrl: null });
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

  localTest("清理：名下不可变控制面行随库一起删除，UPDATE 仍禁；重复 purge 返回幂等结果", async () => {
    await kit().provision(AGENT, provisionArgs("immut"));
    await db!.query(`
      CREATE quota_audit_event:immut_evt CONTENT {
        event_kind: "quota.test.fixture",
        workspace: (SELECT VALUE id FROM ONLY workspace WHERE slug = "kit-immut" LIMIT 1),
        actor_kind: "system",
        correlation_id: "corr-immut"
      };
      CREATE entitlement_operation:immut_op CONTENT {
        workspace: (SELECT VALUE id FROM ONLY workspace WHERE slug = "kit-immut" LIMIT 1),
        operation_kind: "workspace_provisioning",
        outcome: "succeeded",
        idempotency_key: "immut-op",
        actor_kind: "system",
        effective_at: time::now(),
        correlation_id: "corr-immut"
      };
    `);
    // 测试 workspace 名下的行：UPDATE 仍被不可变事件禁止
    const denied = await db!.query(`UPDATE quota_audit_event:immut_evt SET correlation_id = "mutated";`)
      .then(() => null, (e: Error) => e.message ?? String(e));
    expect(String(denied)).toContain("immutable-control-plane-record");

    // 复现 daec1e5f：清理前这些行的 DELETE 会抛错，使整个 purge 返回 internal error
    const out = await kit().purge(AGENT, { subject: "sub-immut", confirm: "purge sub-immut" });
    expect(out).toMatchObject({ subject: "sub-immut", workspacesPurged: 1, workspacesSkipped: 0 });
    expect(await q(`SELECT * FROM quota_audit_event WHERE id = quota_audit_event:immut_evt;`)).toEqual([]);
    expect(await q(`SELECT * FROM entitlement_operation WHERE id = entitlement_operation:immut_op;`)).toEqual([]);

    const again = await kit().purge(AGENT, { subject: "sub-immut", confirm: "purge sub-immut" });
    expect(again).toMatchObject({ subject: "sub-immut", alreadyPurged: true, workspacesPurged: 0, workspacesSkipped: 0 });

    // 非测试 workspace 的行照旧完全不可变
    await db!.query(`
      INSERT INTO workspace { id: workspace:real, slug: "real-ws", name: "real", db_name: "ws_real", owner_subject: "human-x", status: "active" };
      CREATE quota_audit_event:real_evt CONTENT { event_kind: "quota.test.fixture", workspace: workspace:real, actor_kind: "system", correlation_id: "corr-real" };
    `);
    const stillImmutable = await db!.query(`DELETE quota_audit_event:real_evt;`)
      .then(() => null, (e: Error) => e.message ?? String(e));
    expect(String(stillImmutable)).toContain("immutable-control-plane-record");
    await db!.query(`DELETE workspace WHERE id = workspace:real;`);
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

  localTest("到期 reaper 清理测试物料账号时同样打清理标记，对账不再补登记", async () => {
    await kit().provision(AGENT, provisionArgs("expiring"));
    await db!.query(`UPDATE test_subject SET expires_at = time::now() - 1d WHERE subject = "sub-expiring"; UPDATE workspace SET test_expires_at = time::now() - 1d WHERE slug = "kit-expiring";`);
    // 先删 workspace 行但保留开通行，模拟开通行没被 workspace_db 引用删掉的情形
    const { runTestSubjectReaper } = await import("../test-subjects/reaper");
    await runTestSubjectReaper({ systemDb: queryClient(), dropDatabase: async (n) => { await db!.query(`REMOVE DATABASE IF EXISTS ${n};`); }, log: () => {} });
    expect(await subjectRow("sub-expiring")).toBeUndefined();
    await kit().list(AGENT);
    expect(await subjectRow("sub-expiring")).toBeUndefined();
  });

  localTest("agent 不再回调：到期 reaper 也会删掉测试物料账号自己拥有但从未被标记的库", async () => {
    await kit().provision(AGENT, provisionArgs("quiet"));
    // 模拟收养后后台执行迟到建出、没人标记的第二个库
    await db!.query(`CREATE workspace CONTENT { slug: "kit-quiet-late", name: "late", db_name: "ws_kit_quiet_late", owner_subject: "sub-quiet", status: "active" }; DEFINE DATABASE ws_kit_quiet_late;`);
    await db!.query(`UPDATE test_subject SET expires_at = time::now() - 1d WHERE subject = "sub-quiet";`);
    const { runTestSubjectReaper } = await import("../test-subjects/reaper");
    await runTestSubjectReaper({ systemDb: queryClient(), dropDatabase: async (n) => { await db!.query(`REMOVE DATABASE IF EXISTS ${n};`); }, log: () => {} });
    expect(await databases()).not.toContain("ws_kit_quiet_late");
    expect(await q(`SELECT * FROM workspace WHERE slug = "kit-quiet-late";`)).toEqual([]);
  });

  localTest("清理已被会议清扫列出的测试库后，迟到的清扫不会重建它", async () => {
    const service = kit();
    await service.provision(AGENT, provisionArgs("meeting-gc-race"));
    const database = "ws_kit_meeting_gc_race";
    const sweep = await db!.forkSession();
    const fixture = await db!.forkSession();
    const runBatch = createNativeMeetingBatchRunner(endpoint, () => sweep.accessToken);
    try {
      await fixture.use({ namespace: "main", database });
      await fixture.query(`
        DEFINE TABLE schema_version SCHEMALESS;
        CREATE schema_version:current SET version = 64;
        DEFINE FUNCTION fn::meeting_gc() { CREATE meeting_gc_probe:ran; RETURN false; };
      `);
      expect(await runBatch("main", database)).toBe(false);
      expect((await fixture.query<unknown[]>("SELECT * FROM meeting_gc_probe:ran;"))[0]).toHaveLength(1);
      await fixture.closeSession();

      const failures: string[] = [];
      await sweepNativeMeetingWorkspaces({
        use: (scope) => sweep.use(scope),
        async query(sql) {
          const list = await sweep.query<[string[]]>(sql);
          expect(list[0]).toContain(database);
          const result = await service.purge(AGENT, { subject: "sub-meeting-gc-race", confirm: "purge sub-meeting-gc-race" });
          expect(result).toMatchObject({ workspacesPurged: 1, workspacesSkipped: 0 });
          expect(await databases()).not.toContain(database);
          return list;
        },
      }, "main", (namespace, name) => name === database ? runBatch(namespace, name) : Promise.resolve(false),
      (name) => failures.push(name));
      expect(failures).toEqual([database]);
      expect(await databases()).not.toContain(database);
    } finally {
      await sweep.closeSession();
      if (fixture.isValid) await fixture.closeSession();
    }
  });

  localTest("开通中计入上限；已清理与他人账号不计入", async () => {
    const active = (await kit().list(AGENT));
    const open = active.subjects.filter((s) => !s.expired).length + active.inFlight.length;
    for (let n = open; n < MAX_ACTIVE; n += 1) await kit().provision(AGENT, provisionArgs(`fill${n}`));
    expect(await codeOf(kit().provision(AGENT, provisionArgs("over")))).toBe("limit_reached");
  });
});
