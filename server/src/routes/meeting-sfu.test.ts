import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { ParticipantInfo, Room, SignalRequest, SignalResponse, TrackSource, TrackType } from "@livekit/protocol";
import type { MeetingSfuCredentials, MeetingSfuParticipant, MeetingSfuRoom } from "@surreal-ck/shared";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { decodeJwt, SignJWT } from "jose";
import { handleError } from "../middleware/error";
import { PrivateMeetingSfu } from "../meeting/sfu";
import { createMeetingSfuRoutes } from "./meeting-sfu";

const key = "ck-tests";
const secret = randomBytes(32).toString("hex");
const binary = process.env.LIVEKIT_SERVER_BIN;
const appOrigin = "https://test.example";
const privateAddress = "http://127.0.0.1:18780";
const signalAddress = "http://127.0.0.1:18783";
const config = {
  NODE_ENV: "test" as const,
  MEETING_SFU_PRIVATE_URL: privateAddress,
  MEETING_SFU_SIGNAL_URL: signalAddress,
  MEETING_SFU_APP_ORIGIN: appOrigin,
  MEETING_SFU_KEY: key,
  MEETING_SFU_SECRET: secret,
  MEETING_SFU_MAX_SEATS: 4,
};
const configBody = [
  "port: 18780", "bind_addresses: [127.0.0.1]", "rtc:", "  udp_port: 18782", "  tcp_port: 18781",
  "  use_external_ip: false", "  node_ip: 127.0.0.1", "  stun_servers: [127.0.0.1:3478]",
  "room:", "  auto_create: false", "logging:", "  level: error",
].join("\n");
const topologyFixture = (service?: PrivateMeetingSfu) => createMeetingSfuRoutes({
  config,
  service,
  workspaceScope: {
    async resolveCollaborationScope({ subject, dbName }) {
      if (subject === "disabled") return { kind: "member-missing" };
      return { kind: "participant", scope: { ac: "participant", db: dbName! } };
    },
  },
  requireUser: () => async (c, next) => {
    const rawToken = c.req.header("authorization") ?? "";
    const [subject = "host", db = "workspace1"] = rawToken.split("|");
    c.set("user", {
      subject, rawToken,
      raw: { db, ac: "participant", exp: Math.floor(Date.now() / 1000) + 600, name: subject },
    });
    await next();
  },
  checkTokenActivity: async (rawToken) => rawToken !== "expired|workspace1",
});

test("does not expose a management API or signal entry when SFU is not configured", async () => {
  const app = createMeetingSfuRoutes({
    config: { ...config, NODE_ENV: "production", MEETING_SFU_PRIVATE_URL: "http://203.0.113.10:7880", MEETING_SFU_SIGNAL_URL: "https://signal.example" },
    workspaceScope: { async resolveCollaborationScope() { return { kind: "forbidden" }; } },
    requireUser: () => (_c, next) => next(),
  }).onError(handleError);
  const signal = await app.request("/api/meeting/sfu/signal/rtc/validate");
  expect(signal.status).toBe(503);
  expect((await (await app.request("/api/meeting/sfu/availability")).json()).enabled).toBe(false);
});

test("checks the live lease again when a preauthorized upgrade races a demotion or kick", async () => {
  const service = new PrivateMeetingSfu(
    { privateUrl: privateAddress, signalUrl: signalAddress, key, secret, maxSeats: 4 },
    {
      createRoom: async ({ name }) => new Room({ name }),
      listRooms: async () => [],
      deleteRoom: async () => {},
      removeParticipant: async () => {},
      updateParticipant: async () => new ParticipantInfo(),
    },
  );
  try {
    const host = { workspace: "workspace1", subject: "host", name: "host", expiresAt: Date.now() + 300_000 };
    const guest = { ...host, subject: "speaker" };
    const room = await service.create(host, 4);
    const admitted = await service.invite(host, room.id, guest.subject, "speaker");
    const credentials = await service.credentials(guest, room.id);
    const lease = await service.authorizeSignal(credentials.token);
    expect(lease).toBeDefined();
    let disconnected = 0;
    expect(service.attachSignal(lease!, () => { disconnected++; })).toBeDefined();
    await service.stopPublishing(host, room.id, admitted.id);
    expect(disconnected).toBe(1);
    expect(service.attachSignal(lease!, () => {})).toBeUndefined();
    const listener = await service.credentials(guest, room.id);
    const listenerLease = await service.authorizeSignal(listener.token);
    expect(listenerLease).toBeDefined();
    await service.kick(host, room.id, admitted.id);
    expect(service.attachSignal(listenerLease!, () => {})).toBeUndefined();
    await expect(service.credentials(guest, room.id)).rejects.toMatchObject({ status: 403 });
  } finally {
    service.close();
  }
});

function control(path: string, actor = "host|workspace1", method: "GET" | "POST" | "DELETE" = "GET", json?: unknown) {
  return fetch(`${signalAddress}/api/meeting/sfu${path}`, {
    method,
    headers: { authorization: actor, "content-type": "application/json" },
    ...(method !== "GET" && json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
}

function signalEndpoint(credentials: MeetingSfuCredentials, validation = false): URL {
  const url = new URL(`${credentials.url}/rtc${validation ? "/validate" : ""}`);
  if (!validation) url.protocol = "ws:";
  url.searchParams.set("access_token", credentials.token);
  url.searchParams.set("auto_subscribe", "0");
  url.searchParams.set("protocol", "15");
  return url;
}

class SignalProbe {
  readonly socket: WebSocket;
  readonly messages: SignalResponse[] = [];
  readonly closed: Promise<void>;

  constructor(grant: MeetingSfuCredentials) {
    this.socket = new WebSocket(signalEndpoint(grant));
    this.socket.binaryType = "arraybuffer";
    this.socket.addEventListener("message", ({ data }) => {
      if (data instanceof ArrayBuffer) this.messages.push(SignalResponse.fromBinary(new Uint8Array(data)));
    });
    this.closed = new Promise((resolve) => this.socket.addEventListener("close", () => resolve(), { once: true }));
  }

  async find(caseName: string, waitMs = 2500): Promise<SignalResponse | undefined> {
    const end = Date.now() + waitMs;
    while (Date.now() < end) {
      const message = this.messages.find((item) => item.message.case === caseName);
      if (message) return message;
      await Bun.sleep(20);
    }
  }

  addTrack(source = TrackSource.CAMERA, type = TrackType.VIDEO) {
    this.socket.send(new SignalRequest({
      message: { case: "addTrack", value: {
        cid: crypto.randomUUID(), name: "probe", type, source,
      } },
    }).toBinary());
  }

  close() { this.socket.close(); }
}

describe.skipIf(!binary)("Bun signal gate and real private LiveKit", () => {
  let livekit: ReturnType<typeof Bun.spawn>;
  let server: ReturnType<typeof Bun.serve>;
  const media = new PrivateMeetingSfu({ privateUrl: privateAddress, signalUrl: signalAddress, key, secret, maxSeats: 4 });

  beforeAll(async () => {
    livekit = Bun.spawn([binary!], {
      env: { ...process.env, LIVEKIT_CONFIG: configBody, LIVEKIT_KEYS: `${key}: ${secret}` },
      stderr: "ignore", stdout: "ignore",
    });
    const deadline = Date.now() + 5000;
    while (!(await fetch(privateAddress).catch(() => undefined))?.ok) {
      if (Date.now() >= deadline) throw new Error("LiveKit failed to start");
      await Bun.sleep(50);
    }
    const app = new Hono().onError(handleError).route("/", topologyFixture(media));
    server = Bun.serve({ hostname: "127.0.0.1", port: 18783, fetch: app.fetch, websocket });
  });

  afterAll(() => {
    media.close();
    server?.stop(true);
    livekit?.kill();
  });

  test("名册监听席更换身份并同时关闭旧信令和 LiveKit 参与者", async () => {
    const actor = { workspace: "workspace1", subject: "host", name: "主持人", expiresAt: Date.now() + 60_000 };
    const listener = { ...actor, subject: "roster:fixture", name: "名册成员" };
    const room = await media.startRoster(actor, 2);
    const first = await media.rosterCredentials(listener, room.id, "first");
    const firstSignal = new SignalProbe(first);
    try {
      expect(await firstSignal.find("join")).toBeDefined();
      expect(first.role).toBe("listener");
      expect(decodeJwt(first.token).name).toBe("名册成员");
      await expect(media.credentials(listener, room.id)).rejects.toThrow();
      await expect(media.invite(actor, room.id, "member", "speaker")).rejects.toThrow();
      const second = await media.rosterCredentials(listener, room.id, "second");
      expect(decodeJwt(second.token).sub).not.toBe(decodeJwt(first.token).sub);
      await firstSignal.closed;
      expect((await fetch(signalEndpoint(first, true))).status).toBe(403);
      const secondSignal = new SignalProbe(second);
      try {
        expect(await secondSignal.find("join")).toBeDefined();
        await media.dropRoster(actor.workspace, room.id, listener.subject);
        await secondSignal.closed;
        expect((await fetch(signalEndpoint(second, true))).status).toBe(403);
      } finally {
        secondSignal.close();
      }
    } finally {
      firstSignal.close();
      await media.endRoster(actor.workspace, room.id);
    }
  }, 15_000);

  test("真实 LiveKit：举手、仅麦克风授权、撤权、全员静音与结束", async () => {
    const actor = { workspace: "workspace1", subject: "host", name: "主持人", workspaceAdmin: true, expiresAt: Date.now() + 60_000 };
    const guest = { ...actor, subject: "roster:guest", name: "参会人甲", workspaceAdmin: false };
    const other = { ...guest, subject: "roster:other", name: "参会人乙" };
    const room = await media.startRoster(actor, 4);
    const grant = await media.rosterCredentials(guest, room.id, "guest-lease");
    const otherGrant = await media.rosterCredentials(other, room.id, "other-lease");
    const signal = new SignalProbe(grant);
    const otherSignal = new SignalProbe(otherGrant);
    try {
      expect(await signal.find("join")).toBeDefined();
      expect(await otherSignal.find("join")).toBeDefined();
      signal.addTrack(TrackSource.MICROPHONE, TrackType.AUDIO);
      expect(await signal.find("trackPublished", 250)).toBeUndefined();
      await media.raiseRosterHand(actor.workspace, room.id, other.subject, "other-lease");
      await media.raiseRosterHand(actor.workspace, room.id, guest.subject, "guest-lease");
      await media.raiseRosterHand(actor.workspace, room.id, other.subject, "other-lease");
      const queued = media.rosterModeration(actor, room.id).participants;
      expect(queued.map(({ name }) => name)).toEqual(["参会人乙", "参会人甲"]);
      expect(queued.every(({ raisedAt }) => typeof raisedAt === "number")).toBe(true);
      await expect(media.moderateRoster({ ...guest, workspaceAdmin: true }, room.id, { action: "mute-all" })).rejects.toMatchObject({ status: 403 });
      await media.moderateRoster(actor, room.id, { action: "lock", locked: true });
      await expect(media.rosterCredentials({ ...guest, subject: "roster:new" }, room.id, "new-lease")).rejects.toMatchObject({ status: 423 });
      expect((await media.rosterCredentials(guest, room.id, "guest-lease")).role).toBe("listener");
      const id = decodeJwt(grant.token).sub!;
      await media.moderateRoster(actor, room.id, { action: "allow", identity: id });
      signal.addTrack(TrackSource.SCREEN_SHARE);
      signal.addTrack(TrackSource.MICROPHONE, TrackType.VIDEO);
      expect(await signal.find("trackPublished", 250)).toBeUndefined();
      signal.addTrack(TrackSource.MICROPHONE, TrackType.AUDIO);
      expect(await signal.find("trackPublished")).toBeDefined();
      signal.messages.length = 0;
      const withdrawAt = performance.now();
      await media.moderateRoster(actor, room.id, { action: "withdraw", identity: id });
      signal.addTrack(TrackSource.MICROPHONE, TrackType.AUDIO);
      expect(await signal.find("trackPublished", 250)).toBeUndefined();
      expect(performance.now() - withdrawAt).toBeLessThan(2000);
      await media.moderateRoster(actor, room.id, { action: "allow", identity: id });
      await media.moderateRoster(actor, room.id, { action: "allow", identity: decodeJwt(otherGrant.token).sub! });
      expect((await media.moderateRoster(actor, room.id, { action: "mute-all" })).participants.every((p) => !p.speaking)).toBe(true);
      otherSignal.addTrack(TrackSource.MICROPHONE, TrackType.AUDIO);
      expect(await otherSignal.find("trackPublished", 250)).toBeUndefined();
      await media.moderateRoster(actor, room.id, { action: "focus", focus: "screen" });
      expect(media.rosterFocus(actor.workspace, room.id)).toBe("screen");
      const endAt = performance.now();
      await media.endRoster(actor.workspace, room.id);
      await Promise.race([Promise.all([signal.closed, otherSignal.closed]), Bun.sleep(3000)]);
      expect(signal.socket.readyState).toBe(WebSocket.CLOSED);
      expect(otherSignal.socket.readyState).toBe(WebSocket.CLOSED);
      expect(performance.now() - endAt).toBeLessThan(3000);
      expect(await media.authorizeSignal(grant.token)).toBeUndefined();
    } finally {
      signal.close();
      otherSignal.close();
      await media.endRoster(actor.workspace, room.id);
    }
  }, 15_000);

  test("rejects forged/cross-workspace grants, enforces listener permission, and revokes active signals", async () => {
    const host = "host|workspace1";
    const listener = "listener|workspace1";
    const speaker = "speaker|workspace1";
    expect((await control("/rooms", host, "POST", { seats: 4, mode: "controlled" })).status).toBe(503);
    const response = await control("/rooms", host, "POST", { seats: 4, large: true });
    expect(response.status).toBe(201);
    const { id } = await response.json() as MeetingSfuRoom;
    const path = `/rooms/${id}`;
    expect((await control("/rooms", host, "POST", { seats: 1, large: true })).status).toBe(409);
    expect((await control(`${path}/credentials`, listener, "POST")).status).toBe(403);
    expect((await control(`${path}/participants`, host, "POST", { subject: "listener", role: "host" })).status).toBe(400);
    const allow = await control(`${path}/participants`, host, "POST", { subject: "listener", role: "listener" });
    expect(allow.status).toBe(201);
    const invited = await allow.json() as MeetingSfuParticipant;
    const allowSpeaker = await control(`${path}/participants`, host, "POST", { subject: "speaker", role: "speaker" });
    expect(allowSpeaker.status).toBe(201);
    const invitedSpeaker = await allowSpeaker.json() as MeetingSfuParticipant;
    expect((await control(`${path}/credentials`, "listener|workspace2", "POST")).status).toBe(403);
    expect((await control(`${path}/credentials`, "expired|workspace1", "POST")).status).toBe(401);
    const listenerGrant = await (await control(`${path}/credentials`, listener, "POST")).json() as MeetingSfuCredentials;
    const speakerGrant = await (await control(`${path}/credentials`, speaker, "POST")).json() as MeetingSfuCredentials;
    expect(listenerGrant.role).toBe("listener");
    const { sub, iss, exp, video } = decodeJwt(listenerGrant.token);
    expect(video).toEqual({
      roomJoin: true, room: `ck-meeting-${id}`, canPublish: false, canSubscribe: true,
      canPublishData: false, canUpdateOwnMetadata: false,
    });
    expect(exp! - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(90);
    const validation = signalEndpoint(listenerGrant, true);
    expect((await fetch(validation, { headers: { origin: appOrigin } })).headers.get("access-control-allow-origin")).toBe(appOrigin);
    expect((await fetch(validation, { headers: { origin: "https://other.example" } })).status).toBe(403);
    const forged = await new SignJWT({ video: { roomJoin: true, room: `ck-meeting-${id}`, canPublish: true } })
      .setIssuer(iss!).setSubject(sub!).setExpirationTime(exp!).setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode(randomBytes(32).toString("hex")));
    expect((await fetch(signalEndpoint({ ...listenerGrant, token: forged }, true))).status).toBe(403);
    expect((await fetch(`${signalAddress}/twirp/livekit.RoomService/ListRooms`, { method: "POST" })).status).toBe(404);
    const listenerSignal = new SignalProbe(listenerGrant);
    const speakerSignal = new SignalProbe(speakerGrant);
    try {
      expect(await listenerSignal.find("join")).toBeDefined();
      expect(await speakerSignal.find("join")).toBeDefined();
      listenerSignal.addTrack();
      listenerSignal.addTrack(TrackSource.MICROPHONE, TrackType.AUDIO);
      listenerSignal.addTrack(TrackSource.SCREEN_SHARE);
      speakerSignal.addTrack();
      expect(await speakerSignal.find("trackPublished")).toBeDefined();
      expect(await listenerSignal.find("trackPublished", 250)).toBeUndefined();
      expect((await control(`${path}/participants/${invitedSpeaker.id}/stop-publishing`, host, "POST")).status).toBe(204);
      expect((await fetch(signalEndpoint(speakerGrant, true))).status).toBe(403);
      const demoted = await (await control(`${path}/credentials`, speaker, "POST")).json() as MeetingSfuCredentials;
      expect(decodeJwt(demoted.token).video).toMatchObject({ canPublish: false });
      const demotedSignal = new SignalProbe(demoted);
      try {
        expect(await demotedSignal.find("join")).toBeDefined();
        expect((await control(path, listener, "DELETE")).status).toBe(403);
        expect((await control(`${path}/participants/${invited.id}`, host, "DELETE")).status).toBe(204);
        await listenerSignal.closed;
        expect((await fetch(validation)).status).toBe(403);
        expect((await control(`${path}/credentials`, listener, "POST")).status).toBe(403);
        expect((await control(path, host, "DELETE")).status).toBe(204);
        await demotedSignal.closed;
        expect((await fetch(signalEndpoint(demoted, true))).status).toBe(403);
      } finally {
        demotedSignal.close();
      }
      expect((await control("/rooms", host, "POST", { seats: 4, large: true })).status).toBe(201);
    } finally {
      listenerSignal.close();
      speakerSignal.close();
    }
  }, 15000);
});
