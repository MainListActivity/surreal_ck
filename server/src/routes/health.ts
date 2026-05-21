import { Hono } from "hono";
import { checkRootConnection } from "../db/root-connection";
import type { AppBindings } from "../hono-types";

const startedAt = Date.now();

export const healthRoutes = new Hono<AppBindings>();

healthRoutes.get("/health", async (c) => {
  const surrealUp = await checkRootConnection(5000);

  return c.json({
    status: surrealUp ? "ok" : "degraded",
    surrealdb: surrealUp ? "up" : "down",
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
  });
});
