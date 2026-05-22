import { Hono } from "hono";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requireInternalHook } from "../middleware/internal-hook-auth";
import type { WorkspaceScopeModule } from "../workspaces/workspace-scope";

export function createInternalIdpRoutes(workspaceScope: WorkspaceScopeModule): Hono<AppBindings> {
  const routes = new Hono<AppBindings>();

  routes.get("/api/internal/idp/default-scope", requireInternalHook(), async (c) => {
    const subject = c.req.query("subject")?.trim();
    const email = c.req.query("email")?.trim();

    if (!subject) {
      throw new HttpError(400, "idp-default-scope-missing-subject", "Missing subject");
    }

    const result = await workspaceScope.getDefaultScope({
      subject,
      ...(email ? { email } : {}),
    });

    if (result.kind === "login-denied") {
      throw new HttpError(403, "login-denied", "No active workspace for subject");
    }

    return c.json(result.scope);
  });

  return routes;
}
