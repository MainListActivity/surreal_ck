import { describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { MeetingIceServersResponse } from "@surreal-ck/shared";
import { Hono, type MiddlewareHandler } from "hono";
import { createApp } from "../app";
import type { AppBindings } from "../hono-types";
import { handleError } from "../middleware/error";
import type { WorkspaceScopeModule } from "../workspaces/workspace-scope";
import { createMeetingIceRoutes } from "./meeting-ice";

const path = "/api/meeting/ice-servers";
const subject = "fixture-subject";
const workspace = "ws_fixture";
const token = "fixture-bearer";
const secret = "fixture-turn-secret";
const turn = ["turn:relay.example.test:3478", "turns:relay.example.test:5349"];
const stun = ["stun:relay.example.test:3478"];
const unixNow = () => Math.floor(Date.now() / 1000);

type RouteOptions = Parameters<typeof createMeetingIceRoutes>[0];
type ResolveScope = WorkspaceScopeModule["resolveCollaborationScope"];

function fixture(options: {
  exp?: number;
  ac?: string;
  resolve?: Awaited<ReturnType<ResolveScope>>;
  active?: boolean;
  config?: Partial<NonNullable<RouteOptions["config"]>>;
} = {}) {
  const requireUser: MiddlewareHandler<AppBindings> = async (c, next) => {
    c.set("user", {
      subject,
      email: "fixture@example.test",
      rawToken: token,
      raw: { db: workspace, ac: options.ac ?? "participant", exp: options.exp ?? unixNow() + 1_200 },
    });
    await next();
  };
  const resolveCollaborationScope = mock<ResolveScope>(async () =>
    options.resolve ?? { kind: "participant", scope: { db: workspace, ac: "participant" } });
  const checkTokenActivity = mock(async (_token: string) => options.active ?? true);
  const app = new Hono<AppBindings>().route("/", createMeetingIceRoutes({
    workspaceScope: { resolveCollaborationScope },
    requireUser: () => requireUser,
    checkTokenActivity,
    config: {
      TURN_SHARED_SECRET: secret,
      TURN_URLS: turn,
      STUN_URLS: stun,
      TURN_CREDENTIAL_TTL_SECONDS: 900,
      ...options.config,
    },
  })).onError(handleError);
  return { request: () => app.request(path, { method: "POST" }), resolveCollaborationScope, checkTokenActivity };
}

describe("POST /api/meeting/ice-servers", () => {
  test("Bun app requires a valid OIDC bearer", async () => {
    const app = createApp();
    for (const headers of [undefined, { Authorization: "Bearer invalid" }]) {
      expect((await app.request(path, { method: "POST", headers })).status).toBe(401);
    }
  });

  test("rejects missing, revoked or cross-workspace membership with 403", async () => {
    for (const resolve of [
      { kind: "forbidden" },
      { kind: "member-missing" },
      { kind: "participant", scope: { db: "ws_other", ac: "participant" } },
    ] as const) {
      const f = fixture({ resolve });
      expect((await f.request()).status).toBe(403);
      expect(f.resolveCollaborationScope).toHaveBeenCalledWith({ subject, dbName: workspace });
      expect(f.checkTokenActivity).not.toHaveBeenCalled();
    }
    const f = fixture({ ac: "employee" });
    expect((await f.request()).status).toBe(403);
    expect(f.resolveCollaborationScope).not.toHaveBeenCalled();
  });

  test("rejects expired and introspection-inactive tokens with 401", async () => {
    const expired = fixture({ exp: unixNow() - 1 });
    expect((await expired.request()).status).toBe(401);
    expect(expired.resolveCollaborationScope).not.toHaveBeenCalled();
    const revoked = fixture({ active: false });
    expect((await revoked.request()).status).toBe(401);
    expect(revoked.checkTokenActivity).toHaveBeenCalledWith(token);
  });

  test("returns 503 if either TURN configuration input is absent", async () => {
    for (const config of [{ TURN_SHARED_SECRET: undefined }, { TURN_URLS: [] }]) {
      const f = fixture({ config });
      expect((await f.request()).status).toBe(503);
      expect(f.checkTokenActivity).not.toHaveBeenCalled();
    }
  });

  test("issues no-store REST credentials for the authorized workspace", async () => {
    const f = fixture({ ac: "admin" });
    const before = unixNow();
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body: MeetingIceServersResponse = await response.json();
    expect(body.ttlSeconds).toBe(900);
    const expiryUnix = Date.parse(body.expiresAt) / 1000;
    expect(expiryUnix).toBeGreaterThanOrEqual(before + 900);
    expect(expiryUnix).toBeLessThanOrEqual(unixNow() + 900);
    expect(body.iceServers).toHaveLength(2);
    expect(body.iceServers[0]).toEqual({ urls: stun });
    const relay = body.iceServers[1];
    expect(relay.urls).toEqual(turn);
    expect(relay.username).toMatch(new RegExp(`^${expiryUnix}:[0-9a-f]{64}$`, "u"));
    expect(relay.credential).toBe(createHmac("sha1", secret).update(relay.username!).digest("base64"));
    expect(f.resolveCollaborationScope).toHaveBeenCalledWith({ subject, dbName: workspace });
    expect(f.checkTokenActivity).toHaveBeenCalledWith(token);
  });

  test("omits optional STUN and never outlives the bearer", async () => {
    const exp = unixNow() + 30;
    const response = await fixture({ config: { STUN_URLS: [] }, exp }).request();
    expect(response.status).toBe(200);
    const body: MeetingIceServersResponse = await response.json();
    expect(body.iceServers).toHaveLength(1);
    expect(body.iceServers[0]?.urls).toEqual(turn);
    expect(body.ttlSeconds).toBeLessThanOrEqual(30);
    expect(body.expiresAt).toBe(new Date(exp * 1000).toISOString());
  });
});
