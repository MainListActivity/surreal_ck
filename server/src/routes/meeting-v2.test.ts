import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { Hono } from "hono";
import { Surreal } from "surrealdb";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import type { AppBindings } from "../hono-types";
import { requireOidc } from "../middleware/oidc";
import { handleError } from "../middleware/error";
import { MeetingV2, type MeetingRoomState, type MeetingStore } from "./meeting-v2-state";
import { SurrealMeetingStore } from "./meeting-v2-store";
import { createMeetingV2Routes } from "./meeting-v2";

const database = "ws_0123456789ab";
const namespace = "main";
const origin = "https://meeting.test";
const key = "fixture-meeting-key";
const room = "8".repeat(64);
const endpoint = "/api/meeting/v2";

class MemoryMeetingStore implements MeetingStore {
  #rooms = new Map<string, { revision: number; state: MeetingRoomState }>();
  async read(db: string, id: string) { return structuredClone(this.#rooms.get(db + id) ?? null); }
  async write(db: string, id: string, revision: number | null, state: MeetingRoomState) {
    if ((this.#rooms.get(db + id)?.revision ?? null) !== revision) return false;
    this.#rooms.set(db + id, { revision: (revision ?? -1) + 1, state: structuredClone(state) });
    return true;
  }
}

function fixture(store: MeetingStore, clock = Date.now) {
  const service = new MeetingV2(store, key, clock);
  const app = new Hono<AppBindings>().route("/", createMeetingV2Routes({
    service, origin, sourceIp: () => "192.0.2.1", checkActivity: async () => true,
    workspaceScope: { resolveCollaborationScope: async () => ({ kind: "participant", scope: { db: database, ac: "participant" } }) },
    requireUser: () => async (c, next) => {
      const subject = c.req.header("authorization");
      if (!subject) return requireOidc()(c, next);
      c.set("user", { subject, rawToken: subject, email: "fixture@example.test", raw: { db: database, ac: "participant" } });
      await next();
    },
    inviteSubjects: async (_db, recipients) => recipients,
  })).onError(handleError);
  const request = (kind: "guest" | "member", op: string, data: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    app.request(endpoint + "/" + kind, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ op, ...data }),
    });
  const member = (op: string, data: Record<string, unknown> = {}, subject = "host") =>
    request("member", op, { room, join_id: room, ...data }, { authorization: subject });
  const host = (action: string, data: Record<string, unknown> = {}) => member("guest_host", { action, ...data });
  const guest = (op: string, data: Record<string, unknown> = {}, cookie = "") => request("guest", op, data, { cookie });
  return { service, app, member, host, guest, request };
}

type Fixture = ReturnType<typeof fixture>;
async function issue(f: Fixture, code = "012345") {
  const res = await f.host("rotate", { code });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}
async function open(f: Fixture, token: string, code = "012345") {
  const res = await f.guest("open", { name: "访客甲", token, code });
  expect(res.status).toBe(200);
  const set = res.headers.get("set-cookie") ?? "";
  expect(set).toContain("HttpOnly");
  expect(set).toContain("Secure");
  expect(set).toContain("SameSite=Lax");
  return set.split(";")[0] ?? "";
}

async function admitted(f: Fixture) {
  expect((await f.member("create", { nonce: room })).status).toBe(200);
  expect(await (await f.host("status")).json()).toEqual({ enabled: false, locked: false, expires: null, guests: [] });
  const token = await issue(f);
  const cookie = await open(f, token);
  expect(await (await f.guest("status", {}, cookie)).json()).toEqual({ status: "waiting" });
  for (const op of ["snapshot", "connect", "poll_offers", "poll_answers", "ice", "post_offer", "end"]) {
    const res = await f.guest(op, {}, cookie);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "meeting-denied", message: "会议请求被拒绝" } });
  }
  const list = await (await f.host("status")).json() as { guests: { id: string }[] };
  const id = list.guests[0]?.id ?? "";
  expect((await f.member("guest_host", { action: "admit", id }, "uninvited")).status).toBe(403);
  expect((await f.host("admit", { id })).status).toBe(200);
  const connectionResponse = await f.guest("connect", {}, cookie);
  expect(connectionResponse.status).toBe(200);
  const connected = await connectionResponse.json() as {
    connection: string; snapshot: { local_join: string; workspace: string; members: { member: string; join_id: string }[] };
  };
  expect(connected.snapshot.workspace).toBe("meeting");
  expect(connected.snapshot.members.some((member) => member.member.startsWith("guest:"))).toBe(true);
  return { ...connected, id, cookie, token };
}

test("真实 fork：V2 持久化、仅获准信令、代际替换、移出及关闭后的重放", async () => {
  const port = 26_000 + Math.floor(Math.random() * 15_000);
  const password = crypto.randomUUID();
  const binary = process.env.SURREAL_BINARY ?? `${homedir()}/.surrealdb/surreal`;
  const proc = Bun.spawn([binary, "start", "--allow-all", "--bind", `127.0.0.1:${port}`, "--user", "t", "--pass", password, "memory"], { stdout: "ignore", stderr: "ignore" });
  const root = new Surreal();
  const anon = new Surreal();
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* startup */ }
      await Bun.sleep(70);
    }
    const url = `ws://127.0.0.1:${port}/rpc`;
    await root.connect(url);
    await root.signin({ username: "t", password });
    await root.query(`DEFINE NAMESPACE IF NOT EXISTS ${namespace}; USE NS ${namespace}; DEFINE DATABASE IF NOT EXISTS ${database}`).collect();
    await root.use({ namespace, database });
    const scripts = await loadTemplateScripts({ oidcJwksUrl: "https://fixture.invalid/jwks" });
    for (const script of scripts) await root.query(script.sql).collect();
    const f = fixture(new SurrealMeetingStore(key, { url, namespace, credentialSession: async () => root }));
    const { snapshot, cookie, token, connection, id } = await admitted(f);
    expect((await f.member("invite_members", { recipients: ["recipient"] })).status).toBe(200);
    const code = `V2${room.toUpperCase()}`;
    expect((await f.member("join", { code }, "recipient")).status).toBe(409);
    expect((await f.member("join", { code, join_id: snapshot.local_join }, "recipient")).status).toBe(409);
    const memberJoin = "3".repeat(64);
    expect((await f.member("join", { code, join_id: memberJoin }, "recipient")).status).toBe(200);
    expect((await f.member("leave", { join_id: memberJoin }, "recipient")).status).toBe(200);
    const lowIsGuest = snapshot.local_join < room;
    const who = (guestSide: boolean, op: string, extra: Record<string, unknown> = {}) =>
      guestSide ? f.guest(op, { connection, ...extra }, cookie) : f.member(op, extra);
    const offer = JSON.stringify({ type: "offer", sdp: "v=0\r\nm=audio 9 X 0\r\na=fingerprint:sha-256 AA\r\na=ice-ufrag:u\r\na=ice-pwd:p\r\n" });
    const offered = await who(lowIsGuest, "post_offer", {
      peer_join_id: lowIsGuest ? room : snapshot.local_join, attempt: 1, nonce: "a".repeat(64),
      route: "direct", offer, offer_hash: createHash("sha256").update(offer).digest("hex"),
    });
    expect(offered.status).toBe(200);
    const rows = await (await who(!lowIsGuest, "poll_offers")).json() as { id: string; offer_hash: string }[];
    expect(rows).toHaveLength(1);
    const answer = offer.replace('"offer"', '"answer"');
    expect((await who(!lowIsGuest, "post_answer", {
      id: rows[0]?.id, peer_join_id: lowIsGuest ? snapshot.local_join : room, attempt: 1, nonce: "a".repeat(64),
      route: "direct", offer_hash: rows[0]?.offer_hash, answer, answer_hash: createHash("sha256").update(answer).digest("hex"),
    })).status).toBe(200);
    expect(await (await who(lowIsGuest, "poll_answers")).json()).toMatchObject([{ answer }]);
    await anon.connect(url);
    await anon.use({ namespace, database });
    await expect(anon.authenticate(cookie.split("=")[1] ?? "")).rejects.toThrow();
    expect((await f.request("member", "snapshot", { room, join_id: room }, { cookie })).status).toBe(401);
    const [users] = await root.query<[unknown[]]>("SELECT id FROM user").collect();
    expect(users).toEqual([]);
    const replaced = await f.guest("connect", {}, cookie);
    expect(replaced.status).toBe(200);
    expect((await f.guest("snapshot", { connection }, cookie)).status).toBe(401);
    expect((await f.host("remove", { id })).status).toBe(200);
    expect((await f.guest("status", {}, cookie)).status).toBe(401);
    expect((await f.guest("open", { token, code: "012345", name: "访客甲" }, cookie)).status).toBe(403);
    const second = await open(f, token);
    expect((await f.host("close")).status).toBe(200);
    expect((await f.guest("status", {}, second)).status).toBe(401);
    expect((await f.guest("open", { token, code: "012345", name: "访客甲" })).status).toBe(403);
    const newToken = await issue(f);
    const third = await open(f, newToken);
    expect((await f.member("end")).status).toBe(200);
    expect((await f.guest("status", {}, third)).status).toBe(401);
    expect((await f.guest("open", { token, code: "012345", name: "访客甲" })).status).toBe(403);
  } finally {
    await Promise.allSettled([root.close(), anon.close()]);
    proc.kill();
    await proc.exited;
  }
}, 30_000);

test("错误响应一致、锁房阻止新访客、同链接 5 次失败后限流", async () => {
  let now = Date.now();
  const f = fixture(new MemoryMeetingStore(), () => now);
  expect((await f.member("create", { nonce: room })).status).toBe(200);
  const token = await issue(f);
  const check = async (link: string, code: string) => {
    const res = await f.guest("open", { token: link, name: "访客", code });
    return [res.status, await res.json()];
  };
  const wrong = await check(token, "999999");
  expect(wrong[0]).toBe(403);
  expect(await check("invalid", "012345")).toEqual(wrong);
  expect((await f.host("lock")).status).toBe(200);
  expect(await check(token, "012345")).toEqual(wrong);
  expect((await f.host("unlock")).status).toBe(200);
  expect(await check(token, "999999")).toEqual(wrong);
  expect(await check(token, "999999")).toEqual(wrong);
  expect(await check(token, "999999")).toEqual(wrong);
  expect((await check(token, "012345"))[0]).toBe(429);
  const other = await issue(f);
  now += 2 * 60 * 60_000;
  expect(await check(other, "012345")).toEqual(wrong);
  expect((await f.request("guest", "open", { token, code: "012345", name: "访客" }, { Origin: "https://other.test" })).status).toBe(403);
});
