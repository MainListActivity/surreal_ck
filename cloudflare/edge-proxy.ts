export interface Env {
  ORIGIN_BASE_URL: string;
  EDGE_PROXY_SECRET: string;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.ORIGIN_BASE_URL || !env.EDGE_PROXY_SECRET) {
      return jsonError(500, "edge-proxy-not-configured");
    }

    const incoming = new URL(request.url);
    const origin = new URL(env.ORIGIN_BASE_URL);
    origin.pathname = `/__surreal_ck_hono${incoming.pathname}`;
    origin.search = incoming.search;

    const headers = new Headers(request.headers);
    headers.set("x-edge-proxy-secret", env.EDGE_PROXY_SECRET);
    headers.set("x-forwarded-host", incoming.host);
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
      return jsonError(502, "hono-origin-unreachable");
    }
  },
};
