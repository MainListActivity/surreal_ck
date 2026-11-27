import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Context, MiddlewareHandler } from "hono";
import { EDGE_IP_HEADER, PUBLIC_ACTION, PUBLIC_LIMIT_SECONDS, publicEntry, publicRateLimited } from "@surreal-ck/shared/public-entry";
import { env } from "../env";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function publicClientIp(c: Context<AppBindings>): string {
  const fromEdge = c.req.header(EDGE_IP_HEADER);
  const proxySecret = c.req.header("x-edge-proxy-secret");
  if (env.EDGE_PROXY_SECRET && proxySecret && fromEdge && isIP(fromEdge) &&
    timingSafeEqual(Buffer.from(hash(proxySecret)), Buffer.from(hash(env.EDGE_PROXY_SECRET)))) return fromEdge;
  const bun = c.env as { requestIP?(request: Request): { address: string } | null } | undefined;
  return bun?.requestIP?.(c.req.raw)?.address ?? "unknown";
}

export function createSiteverify(
  secret: string | undefined,
  hostnames: readonly string[],
  request = fetch,
  now = Date.now,
) {
  const allowed = new Set(hostnames);
  const used = new Map<string, number>();
  let sweptAt = 0;
  return async (token: unknown, action: string, ip: string): Promise<boolean> => {
    if (!secret?.trim() || !allowed.size || typeof token !== "string" || !token.trim() || token.length > 2048) return false;
    const at = now();
    if (at >= sweptAt + PUBLIC_LIMIT_SECONDS * 1000) {
      for (const [key, expiry] of used) if (expiry <= at) used.delete(key);
      sweptAt = at;
    }
    const key = hash(token);
    if ((used.get(key) ?? 0) > at || used.size >= 32_768) return false;
    used.set(key, at + 300_000);
    try {
      const body = new URLSearchParams({ secret, response: token });
      if (isIP(ip)) body.set("remoteip", ip);
      const response = await request("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        body,
        signal: AbortSignal.timeout(4_000),
        redirect: "error",
      });
      if (!response.ok) return false;
      const data: unknown = await response.json();
      return !!data && typeof data === "object" && "success" in data && data.success === true &&
        "action" in data && data.action === action && "hostname" in data &&
        typeof data.hostname === "string" && allowed.has(data.hostname);
    } catch {
      return false;
    }
  };
}

export function createPublicProtection(options: {
  verify?: ReturnType<typeof createSiteverify>;
  source?: typeof publicClientIp;
  enabled?: boolean;
  now?: () => number;
} = {}) {
  const enabled = options.enabled ?? (env.NODE_ENV === "production" || !!env.TURNSTILE_SECRET || !!env.TRIAL_REQUEST_ORIGIN);
  const verify = options.verify ?? createSiteverify(env.TURNSTILE_SECRET,
    (env.TURNSTILE_HOSTNAMES ?? "").split(",").map(host => host.trim()).filter(host =>
      !!host && (env.NODE_ENV !== "production" || !["localhost", "127.0.0.1", "::1"].includes(host))));
  const ip = options.source ?? publicClientIp;
  const now = options.now ?? Date.now;
  const buckets = new Map<string, { end: number; count: number }>();
  let sweepAt = 0;
  function limit(key: string, max: number) {
    const time = now();
    if (time >= sweepAt) {
      for (const [id, bucket] of buckets) if (bucket.end <= time) buckets.delete(id);
      sweepAt = time + PUBLIC_LIMIT_SECONDS * 1000;
    }
    let bucket = buckets.get(key);
    if (!bucket || bucket.end <= time) {
      if (!bucket && buckets.size >= 32_768) return publicRateLimited();
      bucket = { end: time + PUBLIC_LIMIT_SECONDS * 1000, count: 0 };
      buckets.set(key, bucket);
    }
    if (++bucket.count > max) return publicRateLimited(Math.ceil((bucket.end - time) / 1000));
  }
  const traffic: MiddlewareHandler<AppBindings> = async (c, next) => {
    const entry = publicEntry(c.req.path);
    if (!enabled || !entry || c.req.method === "OPTIONS") return next();
    const source = hash(ip(c));
    const target = hash(entry.target);
    c.header("Cache-Control", "no-store");
    const meeting = entry.area === "guest" || entry.area === "roster";
    return limit(`traffic:${entry.area}:${source}`, meeting ? 2400 : 240) ??
      limit(`target:${entry.area}:${source}:${target}`, meeting ? 1800 : 120) ?? next();
  };
  async function challenge(c: Context<AppBindings>, action: string, target: string, token: unknown, denied: () => HttpError) {
    if (!enabled) return;
    const source = ip(c);
    const meeting = action === PUBLIC_ACTION.roster || action === PUBLIC_ACTION.guest;
    const limited = limit(`verify:${action}:${hash(source)}`, meeting ? 40 : 12);
    if (limited) return limited;
    if (!await verify(token, action, source)) throw denied();
    return limit(`verify:${action}:target:${hash(target)}`, action === PUBLIC_ACTION.trial ? 60 : 8);
  }
  return { enabled, traffic, challenge };
}

// 创建一次，供源站全部公开入口共享请求预算与短期令牌去重。
export const publicProtection = createPublicProtection();
