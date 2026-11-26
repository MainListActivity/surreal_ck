import { SignalRequest, TrackSource, TrackType } from "@livekit/protocol";
import {
  MEETING_SFU_SIGNAL_PATH,
  PRIVATE_MEETING_MAX_SEATS,
  selectMeetingTopology,
} from "@surreal-ck/shared";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { upgradeWebSocket } from "hono/bun";
import { WebhookReceiver } from "livekit-server-sdk";
import { z } from "zod";
import { env, type ServerEnv } from "../env";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { isSfuRoomId, PrivateMeetingSfu, type SfuActor, type SignalLease } from "../meeting/sfu";
import { requireOidc } from "../middleware/oidc";
import { introspectOidcAccessToken, type OidcTokenActivityChecker } from "../oidc/introspection";
import type { WorkspaceScopeModule } from "../workspaces/workspace-scope";

const apiPath = "/api/meeting/sfu";
const rtcPath = `${MEETING_SFU_SIGNAL_PATH}/rtc`;
const webhookPath = "/internal/meeting/sfu/livekit-webhook";
const newRoom = z.strictObject({
  mode: z.enum(["daily", "controlled"]).default("daily"),
  seats: z.number().int().positive(),
  large: z.boolean().default(false),
});
const invitation = z.strictObject({
  subject: z.string().min(1).max(256),
  role: z.enum(["listener", "speaker", "cohost"]),
});

function allowsRosterSignal(data: string | ArrayBufferLike, screenOnly = false): boolean {
  try {
    const { message } = typeof data === "string" ? SignalRequest.fromJsonString(data)
      : SignalRequest.fromBinary(new Uint8Array(data));
    if (message.case === "addTrack") {
      if (screenOnly) return message.value.type === TrackType.VIDEO && message.value.source === TrackSource.SCREEN_SHARE;
      return message.value.type === TrackType.AUDIO && message.value.source === TrackSource.MICROPHONE;
    }
    if (message.case === "offer" || message.case === "answer") {
      return message.value.sdp.split(/\r?\nm=/u).slice(1).every((section) => {
        const media = screenOnly ? /^audio\s+/iu : /^video\s+/iu;
        if (!media.test(section) || /^\w+\s+0(?:[\s/]|$)/iu.test(section)) return true;
        const directions = section.split(/\r?\n/u).filter((line) => /^a=(?:sendrecv|sendonly|recvonly|inactive)$/u.test(line));
        return directions.length === 1 && (directions[0] === "a=recvonly" || directions[0] === "a=inactive");
      });
    }
    return true;
  } catch {
    return false;
  }
}
type Config = Pick<ServerEnv, "MEETING_SFU_PRIVATE_URL" | "MEETING_SFU_SIGNAL_URL" | "MEETING_SFU_KEY"
  | "MEETING_SFU_SECRET" | "MEETING_SFU_APP_ORIGIN" | "MEETING_SFU_MAX_SEATS" | "NODE_ENV">;
type Options = {
  config?: Config;
  workspaceScope: Pick<WorkspaceScopeModule, "resolveCollaborationScope">;
  requireUser?: () => MiddlewareHandler<AppBindings>;
  checkTokenActivity?: OidcTokenActivityChecker;
  service?: PrivateMeetingSfu;
};

function cleanOrigin(raw: string, protocols: string[]): URL | undefined {
  const url = new URL(raw);
  if (!protocols.includes(url.protocol) || url.pathname !== "/" || url.username || url.password || url.search || url.hash) return;
  return url;
}

function resolveConfig(config: Config) {
  const { MEETING_SFU_PRIVATE_URL: privateAddress, MEETING_SFU_SIGNAL_URL: signalAddress,
    MEETING_SFU_APP_ORIGIN: appAddress, MEETING_SFU_KEY: key, MEETING_SFU_SECRET: secret,
    MEETING_SFU_MAX_SEATS: maxSeats } = config;
  if (!privateAddress || !signalAddress || !key || !secret) return;
  const privateUrl = cleanOrigin(privateAddress, ["http:", "https:"]);
  const production = config.NODE_ENV === "production";
  const protocols = production ? ["https:"] : ["http:", "https:"];
  const signalUrl = cleanOrigin(signalAddress, protocols);
  const appUrl = appAddress && cleanOrigin(appAddress, protocols);
  if (!privateUrl || !signalUrl || privateUrl.hostname === signalUrl.hostname && privateUrl.port === signalUrl.port) return;
  if (production && (!appUrl || appUrl.origin === signalUrl.origin
    || !/^(?:10\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|192\.168\.)[\d.]+$/u.test(privateUrl.hostname))) return;
  return { privateUrl: privateUrl.origin, signalUrl: signalUrl.origin, appOrigin: appUrl ? appUrl.origin : undefined, key, secret, maxSeats };
}

export function createPrivateMeetingSfu(config: Config = env, recordTrack?: ConstructorParameters<typeof PrivateMeetingSfu>[3],
  startDaily?: ConstructorParameters<typeof PrivateMeetingSfu>[4]): PrivateMeetingSfu | undefined {
  const resolved = resolveConfig(config);
  return resolved && new PrivateMeetingSfu(resolved, undefined, undefined, recordTrack, startDaily);
}

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, "meeting-sfu-invalid", "大会请求参数无效");
  return result.data;
}

function requireRoomId(value: string): string {
  if (!isSfuRoomId(value)) throw new HttpError(403, "meeting-sfu-denied", "没有权限进入或管理此大会");
  return value;
}

function validUntil(exp: unknown): number {
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp * 1000 <= Date.now()) {
    throw new HttpError(401, "oidc-claim-invalid", "登录会话已过期");
  }
  return exp * 1000;
}

const MAX_SIGNAL_FRAME = 256 * 1024;
const MAX_WEBHOOK_BODY = 256 * 1024;
const signalParams = [
  "auto_subscribe", "reconnect", "sid", "sdk", "version", "protocol",
  "device_model", "os", "os_version", "browser", "browser_version", "adaptive_stream",
  "reconnect_reason", "network",
];

export function createMeetingSfuRoutes({
  config = env, workspaceScope, requireUser = requireOidc, checkTokenActivity = introspectOidcAccessToken,
  service,
}: Options) {
  const resolved = resolveConfig(config);
  const sfu = service ?? createPrivateMeetingSfu(config);
  const webhook = resolved && new WebhookReceiver(resolved.key, resolved.secret);
  const signalRequests = new WeakMap<Request, { lease: SignalLease; upstream: URL }>();

  function requireSfu(): PrivateMeetingSfu {
    if (!sfu) throw new HttpError(503, "meeting-sfu-unavailable", "私有会议服务尚未启用");
    return sfu;
  }

  const actors = new WeakMap<Request, SfuActor>();
  const authenticate: MiddlewareHandler<AppBindings> = async (c, next) => {
    requireSfu();
    const user = c.var.user;
    const { db, ac, exp, name } = user.raw;
    const expiresAt = validUntil(exp);
    if (typeof db !== "string" || !db || (ac !== "admin" && ac !== "participant")) {
      throw new HttpError(403, "workspace-forbidden", "无法访问当前工作区");
    }
    const result = await workspaceScope.resolveCollaborationScope({ subject: user.subject, dbName: db });
    if (result.kind !== "participant" || result.scope.db !== db) {
      throw new HttpError(403, "workspace-forbidden", "无法访问当前工作区");
    }
    if (!(await checkTokenActivity(user.rawToken))) throw new HttpError(401, "oidc-revoked", "登录会话已失效");
    actors.set(c.req.raw, {
      workspace: db, subject: user.subject, expiresAt, workspaceAdmin: ac === "admin",
      name: typeof name === "string" && name.trim() ? name.trim().slice(0, 96) : "参会人",
    });
    c.header("Cache-Control", "no-store");
    await next();
  };

  const signal: MiddlewareHandler<AppBindings> = async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    if (!sfu || !resolved) return c.text("Not available", 503);
    const origin = c.req.header("origin");
    if (origin && resolved.appOrigin && origin !== resolved.appOrigin) return c.text("Forbidden", 403);
    if (origin && origin === resolved.appOrigin) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
    }
    const url = new URL(c.req.url);
    if (url.search.length > 8192) return c.text("Forbidden", 403);
    const queryTokens = url.searchParams.getAll("access_token");
    const authorization = c.req.header("authorization");
    if (queryTokens.length > 1 || (authorization !== undefined && queryTokens.length !== 0)) {
      return c.text("Forbidden", 403);
    }
    const token = authorization === undefined
      ? queryTokens[0]
      : /^Bearer ([A-Za-z0-9._-]{1,8192})$/iu.exec(authorization)?.[1];
    if (!token) return c.text("Forbidden", 403);
    const lease = await sfu.authorizeSignal(token);
    if (!lease) return c.text("Forbidden", 403);
    const target = new URL(c.req.path.endsWith("/validate") ? "/rtc/validate" : "/rtc", resolved.privateUrl);
    target.searchParams.set("access_token", token);
    for (const name of signalParams) {
      const value = url.searchParams.get(name);
      if (value !== null) target.searchParams.set(name, value);
    }
    signalRequests.set(c.req.raw, { lease, upstream: target });
    await next();
  };

  return new Hono<AppBindings>()
    .post(
      webhookPath,
      (c, next) => c.req.header("x-edge-proxy-secret") === undefined ? next() : c.body(null, 404),
      bodyLimit({ maxSize: MAX_WEBHOOK_BODY, onError: (c) => c.text("Payload Too Large", 413) }),
      async (c) => {
        if (!sfu || !webhook) return c.body(null, 503);
        const auth = c.req.header("authorization");
        if (!auth) return c.body(null, 403);
        const raw = await c.req.text();
        const event = await webhook.receive(raw, auth).catch(() => undefined);
        if (!event) return c.body(null, 403);
        const roomId = sfu.observeLiveKitPresence(event);
        if (roomId && !await sfu.flushRosterEvents(roomId)) return c.body(null, 503);
        await sfu.observeRecording(event);
        return c.body(null, 204);
      },
    )
    .get(`${apiPath}/availability`, requireUser(), (c) => c.json({ enabled: Boolean(sfu), maxSeats: resolved?.maxSeats ?? 0 }))
    .post(`${apiPath}/rooms`, requireUser(), authenticate, async (c) => {
      const options = validate(newRoom, await c.req.json().catch(() => null));
      if (options.seats > PRIVATE_MEETING_MAX_SEATS) {
        throw new HttpError(409, "meeting-sfu-capacity", "私有会议容量已满，请减少预计人数或稍后重试");
      }
      // M-08 的名册准入和 M-13 的必录存证可用前，不启动正式外部会议。
      if (options.mode === "controlled") {
        throw new HttpError(503, "meeting-sfu-controlled-unavailable", "名册核验与全程存证未启用，暂不能创建正式外部会议");
      }
      if (selectMeetingTopology(options.mode, options.seats, options.large) === "mesh") {
        throw new HttpError(400, "meeting-sfu-topology", "此场次可使用普通会议，或显式选择私有大会");
      }
      return c.json(await requireSfu().create(actors.get(c.req.raw)!, options.seats), 201);
    })
    .get(`${apiPath}/rooms/:roomId/participants`, requireUser(), authenticate, (c) =>
      c.json(requireSfu().participants(actors.get(c.req.raw)!, requireRoomId(c.req.param("roomId")))))
    .post(`${apiPath}/rooms/:roomId/participants`, requireUser(), authenticate, async (c) => {
      const actor = actors.get(c.req.raw)!;
      const roomId = requireRoomId(c.req.param("roomId"));
      requireSfu().participants(actor, roomId);
      const input = validate(invitation, await c.req.json().catch(() => null));
      const result = await workspaceScope.resolveCollaborationScope({ subject: input.subject, dbName: actor.workspace });
      if (result.kind !== "participant" || result.scope.db !== actor.workspace) {
        throw new HttpError(403, "meeting-sfu-denied", "只能邀请当前工作区的有效成员");
      }
      return c.json(await requireSfu().invite(actor, roomId, input.subject, input.role), 201);
    })
    .get(`${apiPath}/rooms/:roomId/recording`, requireUser(), authenticate, (c) =>
      c.json(requireSfu().recordingState(actors.get(c.req.raw)!, requireRoomId(c.req.param("roomId")))))
    .post(`${apiPath}/rooms/:roomId/recording`, requireUser(), authenticate, async (c) =>
      c.json(await requireSfu().startDailyRecording(actors.get(c.req.raw)!, requireRoomId(c.req.param("roomId")))))
    .post(`${apiPath}/rooms/:roomId/credentials`, requireUser(), bodyLimit({ maxSize: 256 }), authenticate, async (c) => {
      const actor = actors.get(c.req.raw)!;
      const consent = z.strictObject({ consent: z.literal(true) }).safeParse(await c.req.json().catch(() => null)).success;
      return c.json(await requireSfu().credentials(actor, requireRoomId(c.req.param("roomId")), consent));
    })
    .post(`${apiPath}/rooms/:roomId/participants/:identity/stop-publishing`, requireUser(), authenticate, async (c) => {
      await requireSfu().stopPublishing(actors.get(c.req.raw)!, requireRoomId(c.req.param("roomId")), c.req.param("identity"));
      return c.body(null, 204);
    })
    .delete(`${apiPath}/rooms/:roomId/participants/:identity`, requireUser(), authenticate, async (c) => {
      await requireSfu().kick(actors.get(c.req.raw)!, requireRoomId(c.req.param("roomId")), c.req.param("identity"));
      return c.body(null, 204);
    })
    .delete(`${apiPath}/rooms/:roomId`, requireUser(), authenticate, async (c) => {
      await requireSfu().end(actors.get(c.req.raw)!, requireRoomId(c.req.param("roomId")));
      return c.body(null, 204);
    })
    .get(`${rtcPath}/validate`, signal, async (c) => {
      try {
        const response = await fetch(signalRequests.get(c.req.raw)!.upstream, {
          signal: AbortSignal.timeout(3000), redirect: "error",
        });
        return c.text(response.ok ? "success" : "Not available", response.ok ? 200 : 403);
      } catch {
        return c.text("Not available", 503);
      }
    })
    .get(rtcPath, signal, upgradeWebSocket((c) => {
      const { lease, upstream } = signalRequests.get(c.req.raw)!;
      upstream.protocol = upstream.protocol === "https:" ? "wss:" : "ws:";
      let socket: WebSocket | undefined;
      let detach: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      return {
        onOpen(_event, downstream) {
          function close() {
            if (timer) clearTimeout(timer);
            detach?.();
            if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
            if (downstream.readyState < WebSocket.CLOSING) downstream.close(1008, "meeting-sfu-closed");
          }
          detach = sfu?.attachSignal(lease, close);
          if (!detach) return close();
          try {
            socket = new WebSocket(upstream);
            socket.binaryType = "arraybuffer";
            timer = setTimeout(close, 3000);
            socket.onopen = () => { if (timer) clearTimeout(timer); };
            socket.onmessage = ({ data }) => {
              if (typeof data !== "string" && !(data instanceof ArrayBuffer)) return close();
              if ((typeof data === "string" ? data.length : data.byteLength) > MAX_SIGNAL_FRAME) return close();
              downstream.send(data);
            };
            socket.onerror = close;
            socket.onclose = ({ code }) => {
              detach?.();
              if (timer) clearTimeout(timer);
              if (downstream.readyState < WebSocket.CLOSING) downstream.close(code === 1000 ? 1000 : 1011, "meeting-sfu-disconnected");
            };
          } catch {
            close();
          }
        },
        onMessage({ data }, downstream) {
          if (data instanceof Blob) return downstream.close(1008, "meeting-sfu-signal-type");
          const size = typeof data === "string" ? data.length : data.byteLength;
          if (size > MAX_SIGNAL_FRAME || socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > MAX_SIGNAL_FRAME) {
            downstream.close(1008, "meeting-sfu-signal-limit");
          } else if (!(lease.microphoneOnly || lease.screenOnly) || allowsRosterSignal(data, lease.screenOnly)) {
            socket.send(data);
          }
        },
        onClose() {
          if (timer) clearTimeout(timer);
          detach?.();
          if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
        },
      };
    }), (c) => c.text("WebSocket required", 426));
}
