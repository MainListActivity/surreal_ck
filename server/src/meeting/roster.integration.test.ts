import { expect, test } from "bun:test";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { Hono } from "hono";
import { DateTime, Surreal } from "surrealdb";
import { handleError } from "../middleware/error";
import { createMeetingRosterRoutes } from "../routes/meeting-roster";
import { RosterMeetingService } from "./roster";
import type { SfuActor } from "./sfu";

const binary = process.env.SURREAL_BINARY;
const slug = "fixture";
const database = "ws_meeting_roster";
const origin = "https://meeting.test";
const admin = `/api/workspaces/${slug}/roster-meetings`;
const pub = "/api/meeting/roster";
const pepper = "x".repeat(32);

test.skipIf(!binary)("真实 fork：名册会议事务、配额、代际、等候、吊销与数据隔离", async () => {
  const reserve = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = reserve.port;
  reserve.stop(true);
  const password = crypto.randomUUID();
  const proc = Bun.spawn([binary!, "start", "--allow-all", "--bind", `127.0.0.1:${port}`, "--user", "test", "--pass", password, "memory"],
    { stdout: "ignore", stderr: "ignore" });
  const root = new Surreal();
  const member = new Surreal();
  const url = `ws://127.0.0.1:${port}/rpc`;
  try {
    let ready = false;
    for (let i = 0; i < 100 && proc.exitCode === null; i++) {
      if ((await fetch(`http://127.0.0.1:${port}/health`).catch(() => undefined))?.ok) { ready = true; break; }
      await Bun.sleep(50);
    }
    if (!ready) throw new Error("公司 fork 未启动");
    await root.connect(url, { authentication: { username: "test", password }, namespace: "main", database });
    const migrations = await loadTemplateScripts({ oidcJwksUrl: "https://fixture.invalid/jwks" });
    for (const migration of migrations) await root.query(migration.sql).collect();
    await root.query(`
      CREATE workbook_template:fixture SET key = "fixture", label = "会议模板",
        roster_meeting_presets = [{ key: "entry", label: "核验入口", sheet_key: "roster", display_key: "name",
          check_key: "check", check_mode: "suffix4", admission: "waiting", concurrency: "reject" }];
      CREATE workbook:roster SET name = "名册", template = workbook_template:fixture;
      CREATE sheet:roster SET workbook = workbook:roster, label = "名册", table_name = "test_roster",
        template_sheet_key = "roster", column_defs = [{ key: "name" }, { key: "check" }];
      DEFINE TABLE test_roster SCHEMALESS;
      CREATE test_roster:first SET name = "=示例", check = "A1234";
      CREATE test_roster:second SET name = "示例二", check = "A5678";
      CREATE test_roster:third SET name = "示例三", check = "A9101";
      CREATE user:fixture SET email = "member@example.test", kind = "human", is_admin = false;
      DEFINE ACCESS member_record ON DATABASE TYPE RECORD SIGNIN (SELECT * FROM user:fixture) DURATION FOR SESSION 1h;
    `).collect();
    const drops: Array<{ room: string; subject: string }> = [];
    const rooms = new Set<string>();
    const calls: SfuActor[] = [];
    let locked = false;
    let raises = 0;
    let transactions = 0;
    const service = new RosterMeetingService({
      resolveWorkspace: async (name) => name === slug ? { dbName: database } : null,
      getPepper: () => pepper,
      getSession: async (db) => {
        expect(db).toBe(database);
        return { query: (sql, params) => {
          if (sql.includes("BEGIN TRANSACTION")) transactions++;
          return root.query(sql, params).collect();
        } };
      },
      media: {
        maxSeats: 3,
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
    const app = new Hono().onError(handleError).route("/", createMeetingRosterRoutes({
      service, origin, sourceIp: (c) => c.req.header("x-fixture-ip") ?? "192.0.2.1",
      requireUser: () => async (c, next) => {
        c.set("user", { subject: "admin", rawToken: "", raw: { db: database, ac: "admin", exp: Date.now() / 1000 + 600 } });
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
    async function verified(res: Response, state: string) {
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ state, title: "名册大会", name: "=示例" });
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
      passes: { id: string; generation: number; status: string; opened_at: string | null }[];
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
    const [prior] = await passes(room);
    const replacement = await invitation(await request(room + "/passes/reissue", { body: { row_id: "test_roster:first" } }));
    expect(await state(next)).toBe("revoked");
    expect(await (await verify(initial)).json()).toEqual(error);
    const current = await verified(await verify(replacement), "admitted");
    const pass = (await passes(room)).find((item) => item.status === "active")!;
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
    expect((await request(room + "/end", { method: "POST" })).status).toBe(204);
    expect(await state(lastSession)).toBe("revoked");
    expect(await (await request(pub + "/session", { cookie: lastSession })).json()).toMatchObject({ ended: true });
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
    await member.connect(url, { namespace: "main", database });
    await member.signin({ namespace: "main", database, access: "member_record", variables: {} });
    expect(await member.query("SELECT pass_hash, code_hash FROM roster_meeting_pass; SELECT * FROM roster_meeting;").collect()).toEqual([[], []]);
    const [actions] = await root.query<[string[]]>("SELECT VALUE action FROM roster_meeting_audit;").collect();
    expect(actions).toEqual(expect.arrayContaining(["issued", "revoked", "verify_ok", "verify_failed", "replaced", "kicked", "rejected_concurrent"]));
  } finally {
    await Promise.allSettled([member.close(), root.close()]);
    proc.kill();
  }
}, 30_000);
