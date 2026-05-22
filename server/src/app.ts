import { Hono } from "hono";
import { handleError } from "./middleware/error";
import { requestLogger } from "./middleware/logger";
import { healthRoutes } from "./routes/health";
import { createInternalIdpRoutes } from "./routes/internal-idp";
import { createSessionRoutes } from "./routes/session";
import { createWorkspaceScopeModule, type WorkspaceScopeModule } from "./workspaces/workspace-scope";
import type { AppBindings } from "./hono-types";
import type { MiddlewareHandler } from "hono";

export type AppOptions = {
  workspaceScope?: WorkspaceScopeModule;
  requireUser?: () => MiddlewareHandler<AppBindings>;
};

export function createApp(options: AppOptions = {}): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const workspaceScope = options.workspaceScope ?? createWorkspaceScopeModule();

  app.use("*", requestLogger);
  app.onError(handleError);
  app.route("/", healthRoutes);
  app.route("/", createInternalIdpRoutes(workspaceScope));
  app.route("/", createSessionRoutes(workspaceScope, options.requireUser));

  return app;
}

export type AppType = ReturnType<typeof createApp>;
