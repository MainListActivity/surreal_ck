import { EDGE_IP_HEADER, publicEntry, publicRateLimited } from "@surreal-ck/shared/public-entry";

type RateLimit = { limit(options: { key: string }): Promise<{ success: boolean }> };

export interface Env {
  ORIGIN_BASE_URL: string;
  EDGE_PROXY_SECRET: string;
  TRIAL_REQUEST_ORIGIN?: string;
  PUBLIC_ENTRY_LIMIT: RateLimit;
  PUBLIC_MEETING_LIMIT: RateLimit;
}

function jsonError(status: number, code: string): Response {
  return Response.json(
    { error: { code } },
    {
      status,
      headers: { "cache-control": "no-store" },
    },
  );
}

async function entryTarget(request: Request, path: string, fallback: string): Promise<string> {
  if (request.method !== "POST" ||
    (path !== "/api/meeting/roster/verify" && path !== "/api/meeting/v2/guest")) return fallback;
  const reader = request.clone().body?.getReader();
  if (!reader) return fallback;
  let size = 0;
  let json = "";
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) return fallback;
      json += decoder.decode(value, { stream: true });
    }
    const data: unknown = JSON.parse(json + decoder.decode());
    if (!data || typeof data !== "object") return fallback;
    if (path.endsWith("/verify") && "pass" in data && typeof data.pass === "string") return data.pass.slice(0, 160);
    if ("op" in data && data.op === "open" && "token" in data && typeof data.token === "string") return data.token.slice(0, 256);
    return fallback;
  } catch {
    return fallback;
  } finally {
    // 另一条分支仍要传给源站，不能在转发前等待 tee 的取消完成。
    void reader.cancel().catch(() => undefined);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.ORIGIN_BASE_URL || !env.EDGE_PROXY_SECRET) {
      return jsonError(500, "edge-proxy-not-configured");
    }

    const incoming = new URL(request.url);
    if (incoming.pathname.startsWith("/api/meeting/sfu/signal/")) {
      return jsonError(404, "meeting-signal-private-ingress");
    }
    const clientIp = request.headers.get("cf-connecting-ip") ?? "unknown";
    const entry = publicEntry(incoming.pathname);
    const rateResponse = (response: Response) => {
      const origin = request.headers.get("origin");
      if (entry?.area === "trial" && origin && origin === env.TRIAL_REQUEST_ORIGIN) {
        response.headers.set("access-control-allow-origin", origin);
        response.headers.set("access-control-expose-headers", "Retry-After");
        response.headers.set("vary", "Origin");
      }
      return response;
    };
    if (entry && request.method !== "OPTIONS") {
      try {
        const source = `${entry.area}:${clientIp}`;
        const limiter = entry.area === "guest" || entry.area === "roster" ? env.PUBLIC_MEETING_LIMIT : env.PUBLIC_ENTRY_LIMIT;
        if (!(await limiter.limit({ key: source })).success) return rateResponse(publicRateLimited());
        const key = await entryTarget(request, incoming.pathname, entry.target);
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
        const target = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
        if (!(await limiter.limit({ key: `${source}:${target}` })).success) return rateResponse(publicRateLimited());
      } catch {
        return rateResponse(jsonError(503, "public-rate-limit-unavailable"));
      }
    }
    const origin = new URL(env.ORIGIN_BASE_URL);
    origin.pathname = `/__surreal_ck_hono${incoming.pathname}`;
    origin.search = incoming.search;

    const headers = new Headers(request.headers);
    headers.set("x-edge-proxy-secret", env.EDGE_PROXY_SECRET);
    headers.set(EDGE_IP_HEADER, clientIp);
    headers.set("x-forwarded-host", incoming.host);
    headers.set("x-forwarded-proto", incoming.protocol.slice(0, -1));
    // Caddy may overwrite the standard forwarded headers while proxying to
    // Bun. Keep a dedicated public-origin pair for OAuth discovery URLs.
    headers.set("x-surreal-ck-public-host", incoming.host);
    headers.set("x-surreal-ck-public-proto", incoming.protocol.slice(0, -1));
    headers.delete("host");

    const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body;

    try {
      // Keep Upgrade intact: Cloudflare Workers can pass the WebSocket handshake
      // through to the Bun/Hono origin using the ordinary fetch API.
      return await fetch(
        new Request(origin, {
          method: request.method,
          headers,
          body,
          redirect: "manual",
        }),
      );
    } catch {
      return rateResponse(jsonError(502, "hono-origin-unreachable"));
    }
  },
};
