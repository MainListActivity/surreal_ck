import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENTITY_TABLE_MEMBER_PERMISSIONS } from "@surreal-ck/shared";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { extractNativeQuotaError } from "@surreal-ck/shared/native-quota";
import { PUBLIC_ACTION } from "@surreal-ck/shared/public-entry";
import { Hono } from "hono";
import { EgressClient } from "livekit-server-sdk";
import { SignJWT, exportJWK, generateKeyPair, jwtVerify } from "jose";
import { DateTime, RecordId, Surreal, Table, type SurrealSession } from "surrealdb";
import { createCallerSession } from "../ai/caller-session";
import { migrateAllWorkspaces } from "../db/migration-runner";
import { SurrealNativeQuotaClient } from "../db/native-quota/client";
import { materializeWorkspaceMigrationSql } from "../db/workspace-migration-execution";
import { handleError } from "../middleware/error";
import { createPublicProtection, createSiteverify } from "../public-entry/protection";
import { createMeetingRosterRoutes } from "../routes/meeting-roster";
import { createMeetingSfuRoutes } from "../routes/meeting-sfu";
import { createWorkspaceScopeModule } from "../workspaces/workspace-scope";
import { MeetingEvidenceArchive } from "./evidence-archive";
import { recordingBrowser } from "./evidence-browser-fixture";
import { privateEvidenceDirectory } from "./evidence-filesystem";
import { MeetingEvidenceLedger, verifyEvidenceArtifact } from "./evidence-ledger";
import { MeetingTrackRecording } from "./evidence-recording";
import { EvidenceVault, deriveEvidenceWorkspaceKey } from "./evidence-vault";
import { RosterMeetingService } from "./roster";
import { callRosterGateway, RosterMeetingGateway } from "./roster-gateway";
import { PrivateMeetingSfu, type RosterSfuEvent, type SfuActor } from "./sfu";

const binary = process.env.SURREAL_BINARY;
const slug = "fixture";
const database = "ws_meeting_roster";
const origin = "https://meeting.test";
const admin = `/api/workspaces/${slug}/roster-meetings`;
const pub = "/api/meeting/roster";
const pepper = "x".repeat(32);

type ForkFixture = {
  root: Surreal; member: Surreal; owner: Surreal; url: string;
  gateway: RosterMeetingGateway;
  rootSession: (database: string) => Promise<SurrealSession>;
  login: () => Promise<void>;
  adminToken: () => Promise<string>;
  verifyToken: (token: string) => ReturnType<typeof jwtVerify>;
};

async function seedWorkspaceScope(system: SurrealSession) {
  for (const file of ["001-init.surql", "004-quota-commercial-authority.surql", "005-quota-entitlement-reconciliation.surql",
    "009-workspace-provisioning-migration-gates.surql", "048-remote-test-subjects.surql"]) {
    await system.query(await readFile(new URL(`../../../shared/sql/system/${file}`, import.meta.url), "utf8")).collect();
  }
  await system.query(`
    CREATE workspace:fixture SET db_name = $database, slug = $slug, owner_subject = 'fixture-admin', name = '会议', status = 'active',
      desired_entitlement = resource_entitlement:fixture, applied_entitlement = resource_entitlement:fixture,
      desired_quota_projection = quota_policy_projection:fixture, applied_quota_projection = quota_policy_projection:fixture;
    CREATE user_workspace_index:admin SET subject = 'fixture-admin', db_name = $database, workspace = workspace:fixture, role = 'admin';
    CREATE workspace_quota_runtime:fixture SET workspace = workspace:fixture, sync_state = 'in_sync', service_mode = 'standard',
      quota_compliance = 'compliant', capacity_state = 'normal', ledger_state = 'ready', usage_trusted = true, last_native_audit_at = time::now();
  `, { database, slug }).collect();
}

async function withFork(run: (fixture: ForkFixture) => Promise<void>) {
  const version = await Bun.file(binary!).exists() && Bun.spawnSync([binary!, "version"]).stdout.toString();
  if (!version || !version.startsWith("4.0.1-native-quota.1+")) throw new Error("名册联测需要 4.0.1-native-quota.1 公司 fork");
  const reserve = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = reserve.port;
  reserve.stop(true);
  const password = crypto.randomUUID();
  const keys = await generateKeyPair("ES256");
  const publicKey = await exportJWK(keys.publicKey);
  const jwks = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: () => Response.json({ keys: [{ ...publicKey, kid: "fixture", alg: "ES256", use: "sig" }] }),
  });
  const issuer = `http://127.0.0.1:${jwks.port}`;
  const proc = Bun.spawn([binary!, "start", "--allow-all", "--bind", `127.0.0.1:${port}`, "--user", "test", "--pass", password, "memory"],
    { stdout: "ignore", stderr: "ignore" });
  const root = new Surreal();
  const member = new Surreal();
  const owner = new Surreal();
  const url = `ws://127.0.0.1:${port}/rpc`;
  const adminToken = () => new SignJWT({
    ns: "main", db: database, ac: "admin", RL: ["Owner"], email: "admin@example.test",
  }).setSubject("fixture-admin").setIssuer(issuer).setExpirationTime("120s").setIssuedAt()
    .setProtectedHeader({ alg: "ES256", kid: "fixture" }).sign(keys.privateKey);
  const sessions = new Map<string, Promise<SurrealSession>>();
  const openRootSession = async (database: string) => {
    const db = await root.forkSession();
    await db.use({ namespace: "main", database });
    return db;
  };
  const rootSession = (database: string) => {
    const session = sessions.get(database) ?? openRootSession(database);
    sessions.set(database, session);
    return session;
  };
  const gatewaySecret = crypto.randomUUID();
  const gateway = new RosterMeetingGateway(() => gatewaySecret, { url, namespace: "main", credentialSession: rootSession });
  try {
    let ready = false;
    for (let i = 0; i < 100 && proc.exitCode === null; i++) {
      if ((await fetch(`http://127.0.0.1:${port}/health`).catch(() => undefined))?.ok) { ready = true; break; }
      await Bun.sleep(50);
    }
    if (!ready) throw new Error("公司 fork 未启动");
    await root.connect(url, { authentication: { username: "test", password }, namespace: "main", database });
    const migrations = await loadTemplateScripts({ oidcJwksUrl: `${issuer}/jwks` });
    for (const migration of migrations.filter(({ version }) => version <= 73)) await root.query(migration.sql).collect();
    await root.query(`
      UPDATE workspace_resource_quota:current SET plan = resource_quota_plan:max;
      CREATE workbook_template:fixture SET key = "fixture", label = "会议模板",
        roster_meeting_presets = [{ key: "entry", label: "核验入口", sheet_key: "roster", display_key: "name",
          check_key: "check", check_mode: "suffix4", admission: "waiting", concurrency: "reject" }];
      CREATE workbook:roster SET name = "名册", template = workbook_template:fixture;
      CREATE sheet:roster SET workbook = workbook:roster, label = "名册", table_name = "test_roster",
        template_sheet_key = "roster", column_defs = [{ key: "name" }, { key: "check" }, { key: "weight", field_type: "decimal" }];
      DEFINE TABLE test_roster SCHEMALESS;
      CREATE test_roster:first SET name = "=示例", check = "A1234", weight = 7.25dec;
      CREATE test_roster:second SET name = "示例二", check = "A5678", weight = 11.5dec;
      CREATE test_roster:third SET name = "示例三", check = "A9101";
      DEFINE TABLE ent_test_attendance SCHEMALESS;
      DEFINE TABLE ent_test_votes SCHEMALESS;
      CREATE sheet:attendance SET workbook = workbook:roster, label = "签到", table_name = "ent_test_attendance",
        column_defs = [{ key: "meeting_id" }, { key: "subject_id" }, { key: "name" }, { key: "attended", field_type: "checkbox" },
          { key: "duration_ms", field_type: "number" }, { key: "segments" }, { key: "timeline" }];
      CREATE sheet:votes SET workbook = workbook:roster, label = "表决", table_name = "ent_test_votes",
        column_defs = [{ key: "meeting_id" }, { key: "poll_id" }, { key: "title" }, { key: "version" },
          { key: "option" }, { key: "label" }, { key: "count", field_type: "number" }, { key: "weight", field_type: "number" },
          { key: "ballots" }];
      CREATE user:fixture SET email = "member@example.test", kind = "human", is_admin = false;
      CREATE user:admin SET email = "admin@example.test", subject = "fixture-admin", kind = "human", is_admin = true;
      DEFINE ACCESS member_record ON DATABASE TYPE RECORD SIGNIN (SELECT * FROM user:fixture) DURATION FOR SESSION 1h;
      DEFINE TABLE ent_unrelated SCHEMALESS PERMISSIONS FULL;
      CREATE ent_unrelated:sample SET value = "fixture";
      CREATE roster_meeting:legacy SET title = "已有会议", roster_sheet = sheet:roster,
        display_field = 'name', admission = 'direct', created_by = 'fixture-admin', scheduled_at = time::now();
      UPSERT schema_version:current SET version = 73;
    `).collect();
    await seedWorkspaceScope(await rootSession("_system"));
    const migrationOptions = { namespace: "main", loadScripts: async () => migrations };
    const upgraded = await migrateAllWorkspaces(await rootSession("_system"), migrationOptions);
    expect(upgraded.migrated).toEqual([expect.objectContaining({ dbName: database, fromVersion: 73, toVersion: 74 })]);
    const rechecked = await migrateAllWorkspaces(await rootSession("_system"), migrationOptions);
    expect(rechecked).toEqual({ total: 1, migrated: [] });
    await run({ root, member, owner, url, rootSession, adminToken, gateway,
      verifyToken: (token) => jwtVerify(token, keys.publicKey, { issuer }), async login() {
      await member.connect(url, { namespace: "main", database });
      await member.signin({ namespace: "main", database, access: "member_record", variables: {} });
      await owner.connect(url);
      await owner.authenticate(await adminToken());
      await owner.use({ namespace: "main", database });
    } });
  } finally {
    gateway.close();
    await Promise.allSettled([member.close(), owner.close(), root.close()]);
    proc.kill();
    await proc.exited;
    jwks.stop(true);
  }
}

test.skipIf(!binary)("真实 fork：旧管理员 JWT 无法绕过成员、配额和服务模式复核", () => withFork(async (fixture) => {
  const { root, rootSession, adminToken, verifyToken, gateway } = fixture;
  const system = await rootSession("_system");
  const workspaceScope = createWorkspaceScopeModule({ getDbSession: rootSession, namespace: "main" });
  const service = new RosterMeetingService({ getPepper: () => pepper, getSession: gateway.session.bind(gateway),
    resolveWorkspace: async () => ({ dbName: database }) });
  const app = new Hono().onError(handleError).route("/", createMeetingRosterRoutes({
    service, workspaceScope, requireUser: () => async (c, next) => {
      const rawToken = (c.req.header("authorization") ?? "").slice(7);
      const { payload } = await verifyToken(rawToken);
      c.set("user", { subject: payload.sub!, raw: payload, rawToken });
      await next();
    },
  }));
  const token = await adminToken();
  const headers = { authorization: `Bearer ${token}` };
  expect((await app.request(admin, { headers })).status).toBe(200);
  const deny = async () => {
    for (const path of [admin, admin + "/roster_meeting:fixture/passes", admin + "/roster_meeting:fixture/evidence/grant"]) {
      const response = await app.request(path, { headers, method: path.endsWith("/grant") ? "POST" : "GET" });
      expect(response.status).toBe(403);
    }
  };
  await root.query("UPDATE user:admin SET is_admin = false;").collect();
  await deny();
  await root.query("UPDATE user:admin SET is_admin = true, disabled_at = time::now();").collect();
  await deny();
  await root.query("UPDATE user:admin SET disabled_at = NONE;").collect();
  await system.query("UPDATE user_workspace_index:admin SET role = 'participant';").collect();
  await deny();
  await system.query("UPDATE user_workspace_index:admin SET role = 'admin', disabled_at = time::now();").collect();
  await deny();
  await system.query("UPDATE user_workspace_index:admin SET disabled_at = NONE; UPDATE workspace_quota_runtime:fixture SET usage_trusted = false;").collect();
  await deny();
  await system.query("UPDATE workspace_quota_runtime:fixture SET usage_trusted = true, service_mode = 'retention';").collect();
  await deny();
  await system.query("UPDATE workspace_quota_runtime:fixture SET service_mode = 'grace';").collect();
  expect((await app.request(admin, { headers })).status).toBe(200);
}), 30_000);

test.skipIf(!binary)("真实 fork：工作区 A 的名册网关无法读取或更改工作区 B", () => withFork(async ({ root, rootSession, gateway }) => {
  await root.query("DEFINE DATABASE ws_other_roster;").collect();
  const other = await rootSession("ws_other_roster");
  await other.query("DEFINE TABLE roster_meeting SCHEMALESS PERMISSIONS FULL; CREATE roster_meeting:legacy SET title = '工作区 B';").collect();
  const session = await gateway.session(database);
  expect(await session.query("SELECT VALUE title FROM roster_meeting:legacy;")).toEqual([["已有会议"]]);
  await expect(session.query("USE NS main DB ws_other_roster; SELECT VALUE title FROM roster_meeting:legacy;")).rejects.toThrow(/permission|scope/iu);
  await expect(session.query("USE NS main DB ws_other_roster; UPDATE roster_meeting:legacy SET title = '改动';")).rejects.toThrow(/permission|scope/iu);
  expect(await other.query("SELECT VALUE title FROM roster_meeting:legacy;").collect()).toEqual([["工作区 B"]]);
}), 30_000);

test.skipIf(!binary)("真实 fork：名册网关仅可访问会议授权数据，守住 DDL、原生配额与只追加边界", () => withFork(async ({ root, gateway, member, login }) => {
  const session = await gateway.session(database);
  const meeting = new RecordId("roster_meeting", "legacy");
  await expect(session.query("DEFINE TABLE roster_gateway_ddl_probe;")).rejects.toThrow(/permissions/iu);
  await expect(session.query(`DEFINE QUOTA ON DATABASE ${database} RULE probe FOR RECORD MATCH EXACT ent_unrelated LIMIT 1;`)).rejects.toThrow(/permissions/iu);
  expect(await session.query(`
    SELECT id FROM user; SELECT id FROM workbook; SELECT id FROM sheet; SELECT id FROM ent_unrelated; SELECT id FROM test_roster;
    CREATE ent_unrelated:other SET value = '新行'; UPDATE ent_unrelated:sample SET value = '改动'; DELETE ent_unrelated:sample;
  `)).toEqual([[], [], [], [], [], [], [], []]);
  await expect(session.query("SHOW CHANGES FOR TABLE user SINCE d'2000-01-01T00:00:00Z';")).rejects.toThrow(/permission/iu);
  expect(await root.query("SELECT VALUE value FROM ent_unrelated:sample;").collect()).toEqual([["fixture"]]);
  const migration = (await loadTemplateScripts()).find(({ version }) => version === 74)!;
  const replay = await materializeWorkspaceMigrationSql(root, migration);
  await root.query(replay).collect();
  expect(await materializeWorkspaceMigrationSql(root, migration)).toBe(replay);
  expect(await root.query("SELECT VALUE verifier != NONE FROM ONLY roster_meeting_gateway:origin;").collect()).toEqual([true]);
  await root.query(`DEFINE TABLE ent_created_later SCHEMALESS ${ENTITY_TABLE_MEMBER_PERMISSIONS}; CREATE ent_created_later:fixture;`).collect();
  expect(await session.query("SELECT id FROM ent_created_later;")).toEqual([[]]);
  await login();
  expect(await member.query("SELECT VALUE value FROM ent_unrelated:sample;").collect()).toEqual([["fixture"]]);
  expect((await callRosterGateway(member, "rows", { meeting })).status).toBe(403);
  expect(await callRosterGateway(session, "rows", { meeting, ids: [new RecordId("ent_unrelated", "sample")] })).toMatchObject({ status: 400 });
  await session.query("UPDATE $meeting SET roster_sheet = sheet:attendance, display_field = 'weight';", { meeting });
  expect(await root.query("SELECT VALUE roster_sheet FROM $meeting; SELECT VALUE display_field FROM $meeting;", { meeting }).collect())
    .toEqual([[new RecordId("sheet", "roster")], ["name"]]);

  await root.query("UPDATE $meeting SET attendance_sheet = sheet:attendance, vote_sheet = sheet:votes;", { meeting }).collect();
  const binding = {
    meeting, mode: "write", attendance: { id: new RecordId("sheet", "attendance"), table: "ent_test_attendance" },
    vote: { id: new RecordId("sheet", "votes"), table: "ent_test_votes" },
  };
  const outside = await callRosterGateway(session, "archive", {
    ...binding, entries: [{ id: new RecordId("ent_unrelated", "meeting_" + "a".repeat(64)), values: {} }],
  });
  expect(outside.status).toBe(409);
  await root.query(`DEFINE QUOTA ON DATABASE ${database} RULE writeback_cap FOR RECORD MATCH EXACT ent_test_votes LIMIT 1;
    CREATE ent_test_votes:existing;`).collect();
  const quotaFailure = await callRosterGateway(session, "archive", {
    ...binding, entries: [
      { id: new RecordId("ent_test_attendance", "meeting_" + "a".repeat(64)), values: { name: "示例" } },
      { id: new RecordId("ent_test_votes", "meeting_" + "b".repeat(64)), values: { title: "示例" } },
    ],
  }).catch((error: unknown) => error);
  expect(extractNativeQuotaError(quotaFailure)?.code).toBe("quota_exceeded");
  expect(await root.query("SELECT id FROM ent_test_attendance; SELECT VALUE id FROM ent_test_votes;").collect())
    .toEqual([[], [new RecordId("ent_test_votes", "existing")]]);

  await session.query(`CREATE roster_meeting_event:entry SET meeting = $meeting, subject = test_roster:first,
    pass = roster_meeting_pass:fixture, kind = 'verified', actor = 'fixture';`, { meeting });
  expect(await session.query(`UPDATE roster_meeting_event:entry SET actor = '改动';
    DELETE roster_meeting_event:entry; SELECT VALUE actor FROM roster_meeting_event:entry;`)).toEqual([[], [], ["fixture"]]);
}), 30_000);

test.skipIf(!binary)("真实 fork：公开名册需要已通过 Turnstile 的浏览器会话", () => withFork(async ({ root, gateway, owner, login }) => {
  await login();
  const service = new RosterMeetingService({ getPepper: () => pepper, getSession: gateway.session.bind(gateway),
    readQuota: (db) => new SurrealNativeQuotaClient(root).info(db), resolveWorkspace: async () => ({ dbName: database }) });
  const meeting = await service.create(owner, "fixture-admin", { title: "公开入口", scheduled_at: new Date().toISOString(),
    sheet_id: "sheet:roster", display_field: "name", admission: "direct" });
  const [invitation] = await service.issue(database, slug, meeting.id, ["test_roster:first"], "fixture-admin");
  const challenge = crypto.randomUUID();
  const siteverify: typeof fetch = Object.assign(async (_request: RequestInfo | URL, init?: RequestInit) => {
    const success = init?.body instanceof URLSearchParams && init.body.get("response") === challenge;
    return Response.json({ success, hostname: new URL(origin).hostname, action: PUBLIC_ACTION.roster });
  }, { preconnect: fetch.preconnect });
  const protection = createPublicProtection({ enabled: true, verify: createSiteverify("fixture", [new URL(origin).hostname], siteverify) });
  const app = new Hono().onError(handleError).route("/", createMeetingRosterRoutes({
    origin, service, protection, workspaceScope: { async hasCurrentAdminScope() { return false; } },
  }));
  const verify = (site: string, turnstileToken?: string) => app.request(pub + "/verify", {
    method: "POST", headers: { origin: site }, body: JSON.stringify({ pass: invitation!.pass, code: invitation!.code, turnstileToken }),
  });
  for (const response of [await verify("https://wrong.test", challenge), await verify(origin), await verify(origin, "invalid")]) {
    expect(response.status).toBe(401);
    expect(response.headers.has("Set-Cookie")).toBe(false);
  }
  const admitted = await verify(origin, challenge);
  expect(admitted.status).toBe(200);
  const cookie = admitted.headers.get("Set-Cookie")!;
  expect(cookie).toMatch(/HttpOnly/u);
  expect((await app.request(pub + "/session")).status).toBe(401);
  expect((await app.request(pub + "/session", { headers: { cookie: cookie.split(";")[0]! } })).status).toBe(200);
  expect((await verify(origin, challenge)).status).toBe(401);
}), 30_000);

test.skipIf(!binary)("真实 fork：名册会议事务、配额、代际、等候、吊销与数据隔离",
  () => withFork(async ({ root, rootSession, member, owner, login, adminToken, url, gateway }) => {
    const drops: Array<{ room: string; subject: string }> = [];
    const rooms = new Set<string>();
    const calls: SfuActor[] = [];
    let locked = false;
    let raises = 0;
    let transactions = 0;
    let recordMediaEvent: ((event: RosterSfuEvent) => Promise<void>) | undefined;
    const service = new RosterMeetingService({
      resolveWorkspace: async (name) => name === slug ? { dbName: database } : null,
      getPepper: () => pepper,
      readQuota: (db) => new SurrealNativeQuotaClient(root).info(db),
      getSession: async (db) => {
        expect(db).toBe(database);
        const session = await gateway.session(db);
        return { query: (sql, params) => {
          if (sql.includes("BEGIN TRANSACTION")) transactions++;
          return session.query(sql, params);
        } };
      },
      media: {
        maxSeats: 3,
        setRosterEventSink(sink) { recordMediaEvent = sink; },
        async startRoster(_actor, seats) {
          const id = crypto.randomUUID();
          rooms.add(id);
          return { id, seats, topology: "sfu", expiresAt: Date.now() + 60_000 };
        },
        hasRosterRoom: (_db, room) => rooms.has(room),
        isRosterLocked: () => locked,
        rosterFocus: () => "auto",
        async raiseRosterHand() { raises++; },
        rosterModeration: () => ({ locked, focus: "auto", participants: [] }),
        async moderateRoster(_actor, _room, command) {
          if (command.action === "lock") locked = command.locked;
          return { locked, focus: "auto", participants: [] };
        },
        assertRosterHost() {},
        async endRoster(_db, room) { rooms.delete(room); },
        async dropRoster(_db, room, subject) { drops.push({ room, subject }); },
        async rosterCredentials(actor) {
          calls.push(actor);
          return { role: "listener", token: "fixture-media", url: "https://sfu.example.test", leaseExpiresAt: actor.expiresAt };
        },
      },
    });
    const callerToken = await adminToken();
    const app = new Hono().onError(handleError).route("/", createMeetingRosterRoutes({
      service, origin, workspaceScope: createWorkspaceScopeModule({ getDbSession: rootSession, namespace: "main" }), sourceIp: (c) => c.req.header("x-fixture-ip") ?? "192.0.2.1",
      openCallerSession: (token, options) => createCallerSession(token, { ...options, surrealUrl: url }),
      requireUser: () => async (c, next) => {
        c.set("user", { subject: "fixture-admin", rawToken: callerToken, raw: { db: database, ac: "admin", exp: Date.now() / 1000 + 60 } });
        await next();
      },
    }));
    const request = (path: string, options: { method?: string; body?: unknown; cookie?: string; ip?: string } = {}) =>
      app.request(path, {
        method: options.method ?? (options.body === undefined ? "GET" : "POST"),
        headers: { origin, cookie: options.cookie ?? "", "x-fixture-ip": options.ip ?? "192.0.2.1" },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    const roster = { title: "名册大会", scheduled_at: new Date().toISOString(), sheet_id: "sheet:roster",
      display_field: "name", check_field: "check", check_mode: "suffix4" };
    const create = async (admission = "direct", concurrency = "replace") => {
      const response = await request(admin, { body: { ...roster, admission, concurrency } });
      expect(response.status).toBe(201);
      const { id } = await response.json() as { id: string };
      return admin + "/" + encodeURIComponent(id);
    };
    async function invitation(response: Response) {
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const [, line] = (await response.text()).split("\r\n");
      const [name, code, link] = line!.split(",");
      const fragment = new URLSearchParams(new URL(link!).hash.slice(1));
      const pass = fragment.get("pass")!;
      expect(fragment.get("check_label")).toBe("名册校对");
      expect(code).toMatch(/^\d{6}$/);
      expect(pass).toMatch(/^fixture\./);
      return { name, code, pass };
    }
    const verify = ({ pass, code }: { pass: string; code: string }, check = "1234", ip?: string) =>
      request(pub + "/verify", { body: { pass, code, check }, ip });
    async function verified(res: Response, state: string, name = "=示例") {
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ state, title: "名册大会", name });
      const header = res.headers.get("Set-Cookie")!;
      for (const flag of ["Secure", "HttpOnly", "SameSite=Strict"]) expect(header).toContain(flag);
      return header.split(";")[0]!;
    }
    const state = async (cookie: string) => (await (await request(pub + "/session", { cookie })).json() as { state: string }).state;
    const media = (cookie: string) => request(pub + "/credentials", { method: "POST", cookie });
    const zeroPasses = async () => expect(await root.query("SELECT id FROM roster_meeting_pass; SELECT id FROM roster_meeting_audit;").collect()).toEqual([[], []]);
    expect((await request(admin, { body: { ...roster, display_field: "missing", admission: "direct" } })).status).toBe(400);
    const preset = await request(admin, { body: {
      title: "模板会议", scheduled_at: roster.scheduled_at, sheet_id: roster.sheet_id, preset_key: "entry",
    } });
    expect(preset.status).toBe(201);
    expect(await preset.json()).toMatchObject({
      display_field: "name", check_field: "check", check_mode: "suffix4", admission: "waiting", concurrency: "reject",
    });
    const room = await create();
    await root.query(`DEFINE QUOTA ON DATABASE ${database} RULE pass_cap FOR RECORD MATCH EXACT roster_meeting_pass LIMIT 1;`).collect();
    const capped = await request(room + "/passes", { body: { row_ids: ["test_roster:first", "test_roster:second"] } });
    expect(capped.status).toBe(409);
    expect(await capped.json()).toMatchObject({ error: { code: "meeting-roster-quota" } });
    expect(transactions).toBe(0);
    await zeroPasses();
    await root.query(`DEFINE QUOTA OVERWRITE ON DATABASE ${database} EXPECT GENERATION 1 RULE audit_cap FOR RECORD MATCH EXACT roster_meeting_audit LIMIT 1;`).collect();
    const atomic = await request(room + "/passes", { body: { row_ids: ["test_roster:first", "test_roster:second"] } });
    expect(atomic.status).toBe(409);
    expect(transactions).toBe(1);
    await zeroPasses();
    await root.query(`DEFINE QUOTA OVERWRITE ON DATABASE ${database} EXPECT GENERATION 2 RULE pass_cap FOR RECORD MATCH EXACT roster_meeting_pass LIMIT 30;`).collect();
    expect((await request(room + "/passes", { body: { row_ids: ["test_roster:first", "test_roster:missing"] } })).status).toBe(404);
    await zeroPasses();
    const initial = await invitation(await request(room + "/passes", { body: { row_ids: ["test_roster:first"] } }));
    expect(initial.name).toBe("'=示例");
    const duplicate = await request(room + "/passes", { body: { row_ids: ["test_roster:second", "test_roster:first"] } });
    expect(duplicate.status).toBe(409);
    const passes = async (roomPath: string) => (await (await request(roomPath + "/passes")).json() as {
      passes: { id: string; row_id: string; generation: number; status: string; opened_at: string | null }[];
    }).passes;
    expect(await passes(room)).toEqual([expect.objectContaining({ status: "active", opened_at: null })]);
    expect(JSON.stringify(await passes(room))).not.toMatch(/hash|fixture\./);
    const bad = await verify({ pass: initial.pass, code: "invalid-code" });
    expect(bad.status).toBe(401);
    const error = await bad.json();
    for (const response of [await verify(initial, "0000"), await verify({ pass: "invalid", code: initial.code })]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(error);
    }
    const start = await request(room + "/start", { method: "POST" });
    expect(start.status).toBe(201);
    expect(await start.json()).toMatchObject({ seats: 3 });
    const old = await verified(await verify(initial), "admitted");
    const otherPass = await invitation(await request(room + "/passes", { body: { row_ids: ["test_roster:second"] } }));
    const other = await verified(await verify(otherPass, "5678"), "admitted", "示例二");
    const binding = { attendanceSheet: "sheet:attendance", voteSheet: "sheet:votes", weightField: "weight" };
    expect((await request(room + "/archive-config", { method: "PUT", body: binding })).status).toBe(200);
    const options = [{ key: "yes", label: "同意" }, { key: "no", label: "不同意" }];
    const createPoll = async (allowChange: boolean, ms = 60_000) => {
      const response = await request(room + "/polls", { body: {
        title: "配置议题", deadline: new Date(Date.now() + ms).toISOString(), options, allowChange,
      } });
      expect(response.status).toBe(201);
      return encodeURIComponent((await response.json() as { id: string }).id);
    };
    const poll = await createPoll(true);
    const cast = (cookie: string, id: string, body: { option: string; note?: string; requestId?: string }) =>
      request(pub + "/polls/" + id + "/vote", { cookie, body });
    const receipt = (cookie: string, id: string) => request(pub + "/polls/" + id + "/receipt.pdf", { cookie });
    expect((await receipt(other, poll)).status).toBe(404);
    const firstVote = { option: "no", note: "本人书面异议", requestId: crypto.randomUUID() };
    const [a, b] = await Promise.all([cast(old, poll, firstVote), cast(other, poll, { option: "yes", note: "他人说明" })]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await (await cast(old, poll, firstVote)).json()).toEqual(await a.json());
    expect((await cast(old, poll, { option: "yes", note: "更正票", requestId: crypto.randomUUID() })).status).toBe(200);
    expect(await (await cast(old, poll, firstVote)).json()).toMatchObject({ option: "no", note: firstVote.note });
    expect(await (await request(room + "/polls")).json()).toMatchObject({ polls: [{ results: [
      { key: "yes", count: 2, weight: 18.75 }, { key: "no", count: 0, weight: 0 },
    ] }] });
    expect(JSON.stringify(await (await request(pub + "/polls", { cookie: other })).json())).not.toMatch(/更正票|本人书面异议/);
    const pdf = await receipt(other, poll);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("Cache-Control")).toBe("no-store");
    expect(pdf.headers.get("Content-Type")).toBe("application/pdf");
    expect(new TextDecoder().decode((await pdf.bytes()).subarray(0, 5))).toBe("%PDF-");

    const lockedPoll = await createPoll(false, 1200);
    expect((await cast(old, lockedPoll, { option: "yes" })).status).toBe(200);
    expect((await cast(old, lockedPoll, { option: "no" })).status).toBe(409);
    await Bun.sleep(1250);
    expect(await (await cast(other, lockedPoll, { option: "yes" })).json()).toMatchObject({ error: { code: "meeting-poll-closed" } });
    expect(await (await media(old)).json()).toMatchObject({ role: "listener", token: "fixture-media" });
    expect(calls[0]?.name).toBe("=示例");
    expect((await request(pub + "/raise-hand", { method: "POST", cookie: old })).status).toBe(204);
    expect(raises).toBe(1);
    expect(await (await request(room + "/moderation", { body: { action: "lock", locked: true } })).json())
      .toMatchObject({ locked: true });
    expect((await verify(initial)).status).toBe(423);
    expect(await state(old)).toBe("admitted");
    expect((await request(room + "/moderation", { body: { action: "lock", locked: false } })).status).toBe(200);
    const next = await verified(await verify(initial), "admitted");
    expect(await state(old)).toBe("replaced");
    expect((await media(old)).status).toBe(401);
    expect(drops[0]?.subject).toMatch(/^roster:roster_meeting_pass:/);
    expect((await receipt(old, poll)).status).toBe(401);
    const prior = (await passes(room)).find((item) => item.id === drops[0]?.subject.slice("roster:".length));
    const replacement = await invitation(await request(room + "/passes/reissue", { body: { row_id: "test_roster:first" } }));
    expect(await state(next)).toBe("revoked");
    expect(await (await verify(initial)).json()).toEqual(error);
    const current = await verified(await verify(replacement), "admitted");
    const pass = (await passes(room)).find((item) => item.status === "active" && item.row_id === "test_roster:first")!;
    expect(pass.id).not.toBe(prior!.id);
    expect((await request(room + "/passes/" + encodeURIComponent(pass.id), { method: "DELETE" })).status).toBe(204);
    expect(await state(current)).toBe("revoked");
    expect(await (await verify(replacement)).json()).toEqual(error);
    const waitingRoom = await create("waiting", "reject");
    const waitingPass = await invitation(await request(waitingRoom + "/passes", { body: { row_ids: ["test_roster:first"] } }));
    const waiting = await verified(await verify(waitingPass), "waiting");
    expect((await media(waiting)).status).toBe(401);
    expect((await verify(waitingPass)).status).toBe(409);
    const [queued] = (await (await request(waitingRoom + "/waiting")).json() as { waiting: { id: string; generation: number }[] }).waiting;
    const target = waitingRoom + "/passes/" + encodeURIComponent(queued!.id);
    expect((await request(target + "/admit", { body: { generation: queued!.generation + 1 } })).status).toBe(409);
    expect((await request(target + "/admit", { body: { generation: queued!.generation } })).status).toBe(204);
    expect(await state(waiting)).toBe("admitted");
    expect((await request(target + "/kick", { body: { generation: queued!.generation } })).status).toBe(204);
    expect(await state(waiting)).toBe("kicked");
    expect(await (await verify(waitingPass)).json()).toEqual(error);
    const rejectedPass = await invitation(await request(waitingRoom + "/passes/reissue", { body: { row_id: "test_roster:first" } }));
    const rejected = await verified(await verify(rejectedPass), "waiting");
    const [beforeReject] = (await (await request(waitingRoom + "/waiting")).json() as { waiting: { id: string; generation: number }[] }).waiting;
    expect((await request(waitingRoom + "/passes/" + encodeURIComponent(beforeReject!.id) + "/reject", {
      body: { generation: beforeReject!.generation },
    })).status).toBe(204);
    expect(await state(rejected)).toBe("kicked");

    const lastPass = await invitation(await request(room + "/passes/reissue", { body: { row_id: "test_roster:first" } }));
    const lastSession = await verified(await verify(lastPass), "admitted");
    expect(await (await request(pub + "/polls", { cookie: lastSession })).json()).toMatchObject({
      polls: expect.arrayContaining([expect.objectContaining({ ballot: expect.objectContaining({ note: "更正票" }) })]),
    });
    const now = Date.now();
    const id = decodeURIComponent(room.slice(admin.length + 1));
    const [active] = await root.query<[{ pass: string; roomId: string }[]]>(`
      SELECT <string>id AS pass, meeting.room_id AS roomId FROM roster_meeting_pass
      WHERE meeting = type::record($id) AND roster_row = test_roster:first AND status = "active";
    `, { id }).collect();
    expect(recordMediaEvent).toBeDefined();
    const presence = { workspace: database, roomId: active[0]!.roomId, pass: active[0]!.pass };
    for (const segment of [3, 2, 1]) {
      const at = now - 100 * segment;
      const connection = String(segment);
      const joined = { ...presence, kind: "joined" as const, at, connection, key: `join:${segment}` };
      await recordMediaEvent!(joined);
      await recordMediaEvent!(joined);
      await recordMediaEvent!({ ...presence, kind: "left", at: at + 50, connection, key: `left:${segment}` });
    }
    await recordMediaEvent!({ ...presence, kind: "raised", at: now - 25, key: "raised:1" });
    await root.query(`DEFINE QUOTA OVERWRITE ON DATABASE ${database} EXPECT GENERATION 3
      RULE writeback_cap FOR RECORD MATCH EXACT ent_test_votes LIMIT 3;`).collect();
    const beforeArchive = transactions;
    const deniedArchive = await request(room + "/archive", { method: "POST" });
    expect(deniedArchive.status).toBe(409);
    expect(await deniedArchive.json()).toMatchObject({ error: { code: "meeting-archive-quota" } });
    expect(transactions).toBe(beforeArchive);
    expect(await root.query("SELECT * FROM ent_test_attendance; SELECT * FROM ent_test_votes;").collect()).toEqual([[], []]);
    await root.query(`DEFINE QUOTA OVERWRITE ON DATABASE ${database} EXPECT GENERATION 4
      RULE writeback_cap FOR RECORD MATCH EXACT ent_test_votes LIMIT 4;`).collect();
    expect((await request(room + "/end", { method: "POST" })).status).toBe(204);
    for (let i = 0; i < 2; i++) expect(await (await request(room + "/archive", { method: "POST" })).json())
      .toEqual({ attendanceSheet: binding.attendanceSheet, voteSheet: binding.voteSheet });
    const [attendance, summary] = await root.query<[Array<{ subject_id: string; segments: string }>, unknown[]]>(
      "SELECT * FROM ent_test_attendance ORDER BY subject_id; SELECT * FROM ent_test_votes;",
    ).collect();
    expect(attendance).toHaveLength(3);
    expect(attendance).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject_id: "test_roster:first", attended: true, duration_ms: 150, name: "=示例" }),
      expect.objectContaining({ subject_id: "test_roster:third", attended: false, duration_ms: 0, name: "示例三" }),
    ]));
    expect(JSON.parse(attendance[0]!.segments)).toHaveLength(3);
    const [timeline] = await root.query<[string[]]>(
      "SELECT VALUE timeline FROM ent_test_attendance WHERE subject_id = 'test_roster:first';",
    ).collect();
    const mediaKinds = JSON.parse(timeline[0]!) as { kind: string }[];
    expect(mediaKinds.filter(({ kind }) => kind === "joined")).toHaveLength(3);
    expect(mediaKinds.filter(({ kind }) => kind === "raised")).toHaveLength(1);
    expect(summary).toHaveLength(4);
    expect(JSON.stringify(summary)).toMatch(/本人书面异议/);
    await expect(root.query("UPDATE roster_meeting_event SET actor = 'changed';").collect()).rejects.toThrow("readonly");
    await expect(root.query("DELETE roster_meeting_event;").collect()).rejects.toThrow("append only");
    await expect(root.query("DELETE roster_meeting_ballot;").collect()).rejects.toThrow("append only");
    expect(await state(lastSession)).toBe("revoked");
    expect(await (await request(pub + "/session", { cookie: lastSession })).json())
      .toMatchObject({ ended: true, canReadReceipt: true });
    expect((await receipt(lastSession, poll)).status).toBe(200);
    expect((await (await request(pub + "/session", { cookie: old })).json() as { canReadReceipt?: boolean })
      .canReadReceipt).toBeUndefined();
    expect((await receipt(old, poll)).status).toBe(401);
    expect(await (await verify(lastPass)).json()).toEqual(error);
    expect(rooms.size).toBe(0);

    const rateRoom = await create();
    const rate = await invitation(await request(rateRoom + "/passes", { body: { row_ids: ["test_roster:first"] } }));
    for (let i = 0; i < 5; i++) expect((await verify(rate, "wrong", "192.0.2.5")).status).toBe(401);
    expect((await verify(rate, "1234", "192.0.2.6")).status).toBe(429);
    const expiring = await invitation(await request(rateRoom + "/passes/reissue", { body: { row_id: "test_roster:first" } }));
    await root.query("UPDATE roster_meeting_pass SET expires_at = $past WHERE status = 'active';",
      { past: new DateTime(new Date(Date.now() - 1000)) }).collect();
    expect(await (await verify(expiring, "1234", "192.0.2.8")).json()).toEqual(error);
    await login();
    expect(await member.query(`
      SELECT pass_hash, code_hash FROM roster_meeting_pass; SELECT * FROM roster_meeting;
      SELECT * FROM roster_meeting_event; SELECT * FROM roster_meeting_ballot;
    `).collect()).toEqual([[], [], [], []]);
    const events = new Table("roster_meeting_event");
    const ballots = new Table("roster_meeting_ballot");
    expect(await member.update(events).merge({ actor: "changed" })).toEqual([]);
    expect(await member.delete(events)).toEqual([]);
    expect(await member.update(ballots).merge({ choice: "changed" })).toEqual([]);
    expect(await member.delete(ballots)).toEqual([]);

    expect((await owner.select(events)).length).toBeGreaterThan(0);
    expect((await owner.select(ballots)).length).toBeGreaterThan(0);
    await expect(Promise.resolve(owner.update(events).merge({ actor: "changed" }))).rejects.toThrow("readonly");
    await expect(Promise.resolve(owner.delete(events))).rejects.toThrow("append only");
    await expect(Promise.resolve(owner.update(ballots).merge({ choice: "changed" }))).rejects.toThrow("readonly");
    await expect(Promise.resolve(owner.delete(ballots))).rejects.toThrow("append only");
    await expect(Promise.resolve(root.update(ballots).merge({ choice: "changed" }))).rejects.toThrow("readonly");

    const exported = await owner.select<{ id: RecordId; ballots: string }>(new Table("ent_test_votes"));
    const projection = exported.find((row) => row.ballots.includes("本人书面异议"))!;
    const objects = new Map<string, Uint8Array>();
    const vault = new EvidenceVault({
      read: async (key) => objects.get(key) ?? null,
      create: async (key, content) => {
        if (objects.has(key)) return false;
        objects.set(key, content);
        return true;
      },
    }, deriveEvidenceWorkspaceKey(crypto.getRandomValues(new Uint8Array(32))));
    const ledger = new MeetingEvidenceLedger(vault);
    const scope = { workspace: database, meeting: "fixture" };
    const rootHash = await ledger.seal(scope, new Date().toISOString(), null, new Map([
      ["votes.json", Buffer.from(projection.ballots)],
    ]));
    const manifest = await ledger.verifiedManifest(scope, rootHash.toString("hex"));
    const artifact = manifest.files.find(({ path }) => path === "votes.json")!;
    verifyEvidenceArtifact(artifact, Buffer.from(projection.ballots));
    await owner.update(projection.id).merge({ ballots: projection.ballots.replace("本人书面异议", "投影被修改") });
    const tampered = await owner.select<{ ballots: string }>(projection.id);
    expect(tampered?.ballots).toContain("投影被修改");
    expect(() => verifyEvidenceArtifact(artifact, Buffer.from(tampered!.ballots))).toThrow("不匹配");
    expect(await ledger.readVerifiedArtifact(scope, artifact)).toEqual(Buffer.from(projection.ballots));
    const [actions] = await root.query<[string[]]>("SELECT VALUE action FROM roster_meeting_audit;").collect();
    expect(actions).toEqual(expect.arrayContaining(["issued", "revoked", "verify_ok", "verify_failed", "replaced", "kicked", "rejected_concurrent"]));
  }), 30_000);

test.skipIf(!binary)("真实 fork：会议存证投影拒绝改删且独立核验发现投影丢失",
  () => withFork(async ({ root, rootSession, member, owner, login, gateway }) => {
    await login();
    const objects = new Map<string, Uint8Array>();
    const vault = new EvidenceVault({
      read: async (key) => objects.get(key) ?? null,
      create: async (key, content) => {
        if (objects.has(key)) return false;
        objects.set(key, content);
        return true;
      },
    }, deriveEvidenceWorkspaceKey(crypto.getRandomValues(new Uint8Array(32))));
    const archive = new MeetingEvidenceArchive(vault, "fixture archive key", 90,
      gateway.session.bind(gateway));
    const evidenceMeeting = "roster_meeting:⟨2fixture⟩";
    const evidenceStatus = await archive.seal(database, evidenceMeeting, new Date().toISOString(), {}, new Map());
    expect(evidenceStatus.root).toMatch(/^[0-9a-f]{64}$/u);
    const evidenceApp = new Hono().onError(handleError).route("/", createMeetingRosterRoutes({
      service: new RosterMeetingService({ getPepper: () => pepper, resolveWorkspace: async () => ({ dbName: database }) }),
      evidence: archive, origin, workspaceScope: createWorkspaceScopeModule({ getDbSession: rootSession, namespace: "main" }),
      requireUser: () => async (c, next) => {
        const [subject, db, ac] = (c.req.header("authorization") ?? "").split("|");
        c.set("user", { subject: subject ?? "", rawToken: "", raw: { db, ac } });
        await next();
      },
    }));
    const evidencePath = `${admin}/${encodeURIComponent(evidenceMeeting)}/evidence`;
    const grant = await evidenceApp.request(evidencePath + "/grant", {
      method: "POST", headers: { authorization: `fixture-admin|${database}|admin` },
    });
    expect(grant.status).toBe(200);
    const { url: download } = await grant.json() as { url: string };
    expect(download.startsWith(evidencePath + "/download?ticket=")).toBe(true);
    for (const authorization of ["", `member|${database}|participant`, "host|other_workspace|admin"]) {
      expect((await evidenceApp.request(download, { headers: { authorization } })).status).toBe(403);
    }
    const downloaded = await evidenceApp.request(download, { headers: { authorization: `fixture-admin|${database}|admin` } });
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("cache-control")).toBe("no-store");
    expect(downloaded.headers.get("content-type")).toBe("application/x-tar");
    const archives = new Table("meeting_evidence_archive");
    expect(await member.update(archives).merge({ meeting: "changed" })).toEqual([]);
    expect(await member.delete(archives)).toEqual([]);
    const projectionSession = await gateway.session(database);
    expect(await projectionSession.query("UPDATE meeting_evidence_archive SET meeting = 'changed'; DELETE meeting_evidence_archive;")).toEqual([[], []]);
    expect(await archive.status(database, evidenceMeeting)).toEqual(evidenceStatus);
    for (const session of [owner, root]) {
      await expect(Promise.resolve(session.update(archives).merge({ meeting: "changed" }))).rejects.toThrow("readonly");
      await expect(Promise.resolve(session.delete(archives))).rejects.toThrow("append only");
    }
    await owner.query("REMOVE EVENT meeting_evidence_archive_immutable ON TABLE meeting_evidence_archive; DELETE meeting_evidence_archive;").collect();
    await expect(archive.status(database, evidenceMeeting)).rejects.toMatchObject({ status: 409 });
  }), 30_000);

const { M13_TEST_BROWSER: chrome, M13_TEST_WEBHOOK_PORT: hookPort, M13_TEST_ENDPOINT: endpoint,
  M13_TEST_KEY: key, M13_TEST_SECRET: secret, M13_TEST_SPOOL: spool } = process.env;

test.skipIf(!binary || !chrome || !hookPort || !endpoint || !key || !secret || !spool)(
  "真实名册存证：共享屏幕、重新入会、点名、表决异议与视频时间轴相差不超过两秒",
  () => withFork(async ({ root, owner, login, gateway }) => {
    const directory = await mkdtemp(join(tmpdir(), "meeting-alignment-"));
    const vault = new EvidenceVault(privateEvidenceDirectory(directory), deriveEvidenceWorkspaceKey(Buffer.alloc(32, 7)));
    const query = gateway.session.bind(gateway);
    const archive = new MeetingEvidenceArchive(vault, "fixture", 60, query);
    const recording = new MeetingTrackRecording(spool!, new EgressClient(endpoint!, key!, secret!));
    const signalUrl = "http://127.0.0.1:" + hookPort;
    const media = new PrivateMeetingSfu({ privateUrl: endpoint!, signalUrl, key: key!, secret: secret!, maxSeats: 8 },
      undefined, Date.now, recording.start.bind(recording));
    let service: RosterMeetingService;
    const jobs = archive.finalization((job) => service.finalizeEvidence(job));
    service = new RosterMeetingService({ media, evidence: archive, recording, evidenceJobs: jobs, getSession: query,
      readQuota: (db) => new SurrealNativeQuotaClient(root).info(db),
      getPepper: () => pepper, resolveWorkspace: async () => ({ dbName: database }) });
    const routes = createMeetingSfuRoutes({ service: media,
      config: { NODE_ENV: "test", MEETING_SFU_PRIVATE_URL: endpoint!, MEETING_SFU_SIGNAL_URL: signalUrl,
        MEETING_SFU_KEY: key!, MEETING_SFU_SECRET: secret!, MEETING_SFU_MAX_SEATS: 8 },
      workspaceScope: { async resolveCollaborationScope() { return { kind: "forbidden" }; } },
    }).onError(handleError);
    const hook = Bun.serve({ hostname: "127.0.0.1", port: Number(hookPort), fetch: routes.fetch });
    const host = { workspace: database, subject: "fixture-host", name: "主持人", expiresAt: Date.now() + 180_000, workspaceAdmin: true };
    let browser: Awaited<ReturnType<typeof recordingBrowser>> | undefined;
    let roomId: string | undefined;
    const waitFor = async <T>(get: () => Promise<T | undefined>, description: string) => {
      for (let i = 0; i < 100; i++) {
        const result = await get();
        if (result) return result;
        await Bun.sleep(100);
      }
      throw new Error(description);
    };
    try {
      browser = await recordingBrowser(chrome!, join(directory, "chrome"));
      const { evaluate } = browser;
      await login();
      const meeting = (await service.create(owner, host.subject, { title: "存证时间轴", scheduled_at: new Date().toISOString(),
        sheet_id: "sheet:roster", display_field: "name", check_field: "check", check_mode: "suffix4", admission: "direct", concurrency: "replace" })).id;
      const room = await service.start(host, meeting);
      roomId = room.id;
      const [first, second] = await service.issue(database, slug, meeting, ["test_roster:first", "test_roster:second"], host.subject);
      const guest = await service.verify({ pass: first!.pass, code: first!.code, check: "1234" }, "192.0.2.1");
      const secondGuest = await service.verify({ pass: second!.pass, code: second!.code, check: "5678" }, "192.0.2.2");
      const hostGrant = await media.credentials(host, room.id, true);
      const guestGrant = await service.credentials(guest.cookie, true);
      const secondGrant = await service.credentials(secondGuest.cookie, true);
      await evaluate(`(async () => {
        window.connect = async (token) => { const room = new lk.Room(); await room.connect(${JSON.stringify(endpoint)}, token); return room; };
        window.host = await connect(${JSON.stringify(hostGrant.token)});
        window.guest = await connect(${JSON.stringify(guestGrant.token)});
        window.other = await connect(${JSON.stringify(secondGrant.token)});
        const canvas = document.createElement("canvas");
        canvas.width = 320; canvas.height = 180; document.body.append(canvas);
        window.color = "red";
        const paint = () => { const ctx = canvas.getContext("2d"); ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 180); };
        paint();
        setInterval(paint, 25);
        await host.localParticipant.publishTrack(canvas.captureStream(25).getVideoTracks()[0], { source: lk.Track.Source.ScreenShare });
        const audio = new AudioContext();
        const tone = new OscillatorNode(audio, { frequency: 440 });
        const sink = audio.createMediaStreamDestination();
        tone.connect(sink); tone.start();
        await host.localParticipant.publishTrack(sink.stream.getAudioTracks()[0], { source: lk.Track.Source.Microphone });
      })()`);
      const events = () => archive.events(database, meeting);
      const event = (kind: string) => waitFor(async () => (await events()).find((item) => item.kind === kind), `缺少事件 ${kind}`);
      const screen = await waitFor(async () => (await events()).find((item) => item.kind === "track-published"
        && (item.payload as { source: number }).source === 3), "缺少屏幕共享轨道事件");
      await event("joined");
      await Bun.sleep(2200);
      await evaluate(`(async () => { await guest.disconnect(); window.guest = await connect(${JSON.stringify(guestGrant.token)}); })()`);
      const reconnect = await waitFor(async () => {
        const joined = (await events()).filter(({ kind }) => kind === "joined");
        return joined.length >= 3 ? joined.at(-1) : undefined;
      }, "缺少重新入会事件");
      await evaluate('window.color = "lime"');
      await Bun.sleep(800);
      await service.raiseHand(guest.cookie);
      const target = (await service.moderation(host, meeting)).participants.find(({ raisedAt }) => raisedAt)!;
      await service.moderation(host, meeting, { action: "allow", identity: target.id });
      const allowed = await event("allowed");
      await evaluate('window.color = "blue"');
      await Bun.sleep(800);
      const poll = await service.openPoll(host, meeting, { title: "议题", deadline: new Date(Date.now() + 60_000).toISOString(),
        options: [{ key: "yes", label: "同意" }, { key: "no", label: "反对" }], allowChange: false });
      await service.vote(guest.cookie, poll.id, { option: "no", note: "记录异议" });
      const voted = await event("ballot");
      await evaluate('window.color = "white"');
      await Bun.sleep(900);
      await service.end(host, meeting);
      await jobs.resume();
      const { token, root: trustedRoot } = await archive.grant(database, meeting, host.subject);
      const tar = join(directory, "archive.tar");
      const writer = Bun.file(tar).writer();
      for await (const chunk of await archive.download(database, meeting, host.subject, token)) writer.write(chunk);
      await writer.end();
      expect(Bun.spawnSync(["tar", "-xf", tar, "-C", directory]).exitCode).toBe(0);
      expect(Bun.spawnSync(["python3", "../scripts/verify-meeting-evidence.py", directory, "--trusted-root", trustedRoot]).exitCode).toBe(0);
      const sample = Bun.spawnSync(["ffmpeg", "-v", "error", "-i", join(directory, "archive.mp4"), "-an", "-vf",
        "crop=2:2:480:270,fps=25,scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]);
      expect(sample.exitCode).toBe(0);
      const start = Date.parse((await event("recording-started")).at);
      const predicates = [
        (r: number, g: number, b: number) => r > 150 && g < 60 && b < 60,
        (r: number, g: number, b: number) => r < 60 && g > 150 && b < 60,
        (r: number, g: number, b: number) => r < 60 && g < 60 && b > 150,
        (r: number, g: number, b: number) => r > 150 && g > 150 && b > 150,
      ];
      for (const [index, marker] of [screen, reconnect, allowed, voted].entries()) {
        let offset = 0;
        while (offset < sample.stdout.length && !predicates[index]!(sample.stdout[offset]!, sample.stdout[offset + 1]!, sample.stdout[offset + 2]!)) offset += 3;
        expect(offset).toBeLessThan(sample.stdout.length);
        const difference = Math.abs(start + (offset / 3) * 40 - Date.parse(marker.at));
        console.info(`M13 视频对齐 ${marker.kind}: ${difference} ms`);
        expect(difference).toBeLessThanOrEqual(2000);
      }
    } finally {
      browser?.close();
      if (roomId) await media.endRoster(database, roomId).catch(() => undefined);
      hook.stop(true);
      media.close();
      await rm(directory, { recursive: true, force: true });
    }
  }), 60_000);
