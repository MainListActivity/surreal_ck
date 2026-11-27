import type { MiddlewareHandler } from "hono";

export const requestLogger: MiddlewareHandler = async (c, next) => {
  const started = performance.now();

  try {
    await next();
  } finally {
    const durationMs = Math.round((performance.now() - started) * 10) / 10;
    console.info("[http]", {
      method: c.req.method,
      path: c.req.path.replace(/^\/api\/claims-portal\/[^/]+\/[^/]+/u, "/api/claims-portal/[redacted]"),
      status: c.res.status,
      durationMs,
    });
  }
};
