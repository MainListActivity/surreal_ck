import { Hono } from "hono";
import { handleError } from "./middleware/error";
import { requestLogger } from "./middleware/logger";
import { healthRoutes } from "./routes/health";
import type { AppBindings } from "./hono-types";

export function createApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.use("*", requestLogger);
  app.onError(handleError);
  app.route("/", healthRoutes);

  return app;
}

export type AppType = ReturnType<typeof createApp>;
