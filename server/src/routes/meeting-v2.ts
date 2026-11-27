import { PUBLIC_ACTION } from "@surreal-ck/shared/public-entry";
import { publicClientIp, publicProtection } from "../public-entry/protection";
import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { RecordId } from "surrealdb";
import { env } from "../env";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requireOidc } from "../middleware/oidc";
import { introspectOidcAccessToken } from "../oidc/introspection";
import { createCallerSession } from "../ai/caller-session";
import type { WorkspaceScopeModule } from "../workspaces/workspace-scope";
import { commandObject, invalidInvite, MeetingV2 } from "./meeting-v2-state";
import { SurrealMeetingStore } from "./meeting-v2-store";

const path = "/api/meeting/v2";
const cookie = "__Secure-meeting-v2";
const windowMs = 15 * 60_000;
const limited = () => new HttpError(429, "meeting-guest-rate-limited", "尝试过于频繁，请稍后再试");
const forbidden = () => new HttpError(403, "meeting-denied", "会议请求被拒绝");
const unavailable = () => new HttpError(503, "meeting-unavailable", "当前部署未启用访客会议");

class VerificationLimits {
  #sources = new Map<string, { until: number; count: number }>();
  #links = new Map<string, { until: number; count: number }>();
  #nextSweep = 0;

  start(source: string, link: string, now: number): void {
    if (this.#nextSweep <= now) {
      this.#nextSweep = now + 60_000;
      for (const bucket of [this.#sources, this.#links]) {
        for (const [key, item] of bucket) if (item.until <= now) bucket.delete(key);
      }
    }
    let requests = this.#sources.get(source);
    if (!requests || requests.until <= now) {
      if (this.#sources.size >= 16_384) throw limited();
      requests = { until: now + windowMs, count: 0 };
      this.#sources.set(source, requests);
    }
    if (++requests.count > 30) throw limited();
    const failures = this.#links.get(link);
    if (failures && failures.until > now && failures.count >= 5) throw limited();
    if (!failures && this.#links.size >= 32_768) throw limited();
  }

  fail(link: string, now: number): void {
    const item = this.#links.get(link);
    if (!item || item.until <= now) this.#links.set(link, { until: now + windowMs, count: 1 });
    else if (++item.count === 5) item.until = now + 2 * windowMs;
  }
}

type Options = {
  workspaceScope: Pick<WorkspaceScopeModule, "resolveCollaborationScope">;
  requireUser?: () => MiddlewareHandler<AppBindings>;
  protection?: typeof publicProtection;
  service?: MeetingV2;
  origin?: string;
  trustedProxy?: boolean;
  sourceIp?: (c: Context<AppBindings>) => string;
  checkActivity?: typeof introspectOidcAccessToken;
  inviteSubjects?: (token: string, recipients: string[]) => Promise<string[]>;
};

async function inviteSubjects(token: string, recipients: string[]): Promise<string[]> {
  const ids = recipients.map((value) => new RecordId("user", value));
  const db = await createCallerSession(token);
  try {
    const [subjects] = await db.query<[string[]]>(
      "SELECT VALUE subject FROM $ids WHERE kind = 'human' AND disabled_at = NONE AND subject != NONE",
      { ids },
    ).collect();
    return subjects;
  } finally {
    await db.close();
  }
}

function ip(c: Context<AppBindings>, proxy: boolean): string {
  const edge = c.req.header("cf-connecting-ip");
  if (proxy && edge && isIP(edge)) return edge;
  const bun = c.env as { requestIP?: (request: Request) => { address: string } | null } | undefined;
  return bun?.requestIP?.(c.req.raw)?.address ?? "unknown";
}

async function body(c: Context<AppBindings>) {
  const length = Number(c.req.header("content-length") ?? "0");
  if (length > 110_000) throw forbidden();
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw forbidden();
  const decoder = new TextDecoder();
  let bytes = 0;
  let json = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 110_000) throw forbidden();
      json += decoder.decode(part.value, { stream: true });
    }
    return commandObject(JSON.parse(json + decoder.decode()) as unknown);
  } catch {
    throw forbidden();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export function createMeetingV2Routes(options: Options) {
  const routes = new Hono<AppBindings>();
  const key = env.PLATFORM_SECRET_KEY;
  const protection = options.protection ?? publicProtection;
  const service = options.service ?? (key ? new MeetingV2(new SurrealMeetingStore(key), key) : null);
  const origin = options.origin ?? env.MEETING_GUEST_ORIGIN;
  const proxy = options.trustedProxy ?? env.MEETING_GUEST_TRUST_PROXY === "1";
  const requireUser = options.requireUser ?? requireOidc;
  const checkActivity = options.checkActivity ?? introspectOidcAccessToken;
  const limits = new VerificationLimits();

  routes.use(`${path}/*`, async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  });

  routes.post(`${path}/member`, requireUser(), async (c) => {
    if (!service) throw unavailable();
    const { db, ac } = c.var.user.raw;
    if (typeof db !== "string" || (ac !== "admin" && ac !== "participant")) throw forbidden();
    const scope = await options.workspaceScope.resolveCollaborationScope({ subject: c.var.user.subject, dbName: db });
    if (scope.kind !== "participant" || scope.scope.db !== db) throw forbidden();
    const command = await body(c);
    if (command.op === "guest_host" || command.op === "create") {
      if (!origin) throw unavailable();
      if (!(await checkActivity(c.var.user.rawToken))) throw new HttpError(401, "oidc-revoked", "会议主持人身份已失效");
    }
    if (command.op === "invite_members") {
      const values = command.recipients;
      if (!Array.isArray(values) || values.length > 64 || !values.every((id) => typeof id === "string" && /^[a-zA-Z0-9_]{1,128}$/u.test(id))) throw forbidden();
      const subjects = await (options.inviteSubjects ?? inviteSubjects)(c.var.user.rawToken, values.map(String));
      command.recipients = subjects.map((subject) => service.member(db, subject));
    }
    return c.json(await service.memberCommand(db, service.member(db, c.var.user.subject), command));
  });

  routes.post(`${path}/guest`, async (c) => {
    if (!service || !origin) throw unavailable();
    if (c.req.header("origin") !== new URL(origin).origin || !c.req.header("content-type")?.startsWith("application/json")) throw forbidden();
    const command = await body(c);
    const previous = getCookie(c, cookie) ?? "";
    if (command.op === "open") {
      const token = typeof command.token === "string" ? command.token.slice(0, 256) : "";
      const blocked = await protection.challenge(c, PUBLIC_ACTION.guest, token, command.turnstileToken, invalidInvite);
      if (blocked) return blocked;
      const source = options.sourceIp?.(c) ?? (protection.enabled ? publicClientIp(c) : ip(c, proxy));
      const candidate = service.digest("rate-link", token);
      limits.start(service.digest("rate-source", source), candidate, Date.now());
      let value: string;
      try {
        value = await service.open(token,
          typeof command.code === "string" ? command.code : "",
          typeof command.name === "string" ? command.name.trim() : "", previous);
      } catch {
        limits.fail(candidate, Date.now());
        throw invalidInvite();
      }
      setCookie(c, cookie, value, { path: `${path}/guest`, httpOnly: true, secure: true, sameSite: "Lax", maxAge: 7200 });
      return c.json({ ok: true });
    }
    if (command.op === "ice") {
      const permit = await service.guestCommand(previous, command) as { opaque: string; expires: number };
      const secret = env.TURN_SHARED_SECRET;
      if (!secret || env.TURN_URLS.length === 0) throw new HttpError(503, "meeting-turn-unavailable", "会议 TURN 不可用");
      const now = Math.floor(Date.now() / 1000);
      const expiry = Math.min(Math.floor(permit.expires / 1000), now + env.TURN_CREDENTIAL_TTL_SECONDS);
      if (expiry <= now) throw forbidden();
      const username = `${expiry}:${permit.opaque}`;
      return c.json({
        iceServers: [
          ...(env.STUN_URLS.length ? [{ urls: env.STUN_URLS }] : []),
          { urls: env.TURN_URLS, username, credential: createHmac("sha1", secret).update(username).digest("base64") },
        ],
        ttlSeconds: expiry - now, expiresAt: new Date(expiry * 1000).toISOString(),
      });
    }
    return c.json(await service.guestCommand(previous, command));
  });
  return routes;
}
