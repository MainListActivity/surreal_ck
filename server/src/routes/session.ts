import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { requireOidc } from "../middleware/oidc";
import type { WorkspaceScopeModule } from "../workspaces/workspace-scope";

export function createSessionRoutes(
  workspaceScope: WorkspaceScopeModule,
  requireUser: () => MiddlewareHandler<AppBindings> = requireOidc,
): Hono<AppBindings> {
  const routes = new Hono<AppBindings>();

  routes.get("/api/session/workspaces", requireUser(), async (c) => {
    const workspaces = await workspaceScope.listWorkspaces({
      subject: c.var.user.subject,
    });

    return c.json({ workspaces });
  });

  return routes;
}
