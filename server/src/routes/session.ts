import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requireOidc } from "../middleware/oidc";
import type { IdpTokenScopeAdapter } from "../workspaces/idp-scope-adapter";
import type { WorkspaceScopeModule } from "../workspaces/workspace-scope";

export function createSessionRoutes(
  workspaceScope: WorkspaceScopeModule,
  idpTokenScopeAdapter: IdpTokenScopeAdapter,
  requireUser: () => MiddlewareHandler<AppBindings> = requireOidc,
): Hono<AppBindings> {
  const routes = new Hono<AppBindings>();

  routes.get("/api/session/workspaces", requireUser(), async (c) => {
    const workspaces = await workspaceScope.listWorkspaces({
      subject: c.var.user.subject,
    });

    return c.json({ workspaces });
  });

  routes.post("/api/session/switch-workspace", requireUser(), async (c) => {
    const body = await c.req.json().catch(() => null);
    const workspaceSlug = typeof body?.workspaceSlug === "string" ? body.workspaceSlug.trim() : undefined;
    const dbName = typeof body?.dbName === "string" ? body.dbName.trim() : undefined;

    if (!workspaceSlug && !dbName) {
      throw new HttpError(400, "switch-workspace-target-required", "workspaceSlug or dbName is required");
    }

    const result = await workspaceScope.switchWorkspace({
      subject: c.var.user.subject,
      ...(workspaceSlug ? { workspaceSlug } : {}),
      ...(dbName ? { dbName } : {}),
    });

    if (result.kind === "forbidden") {
      throw new HttpError(403, "workspace-forbidden", "Workspace is not accessible");
    }

    await idpTokenScopeAdapter.updateUserScope(c.var.user.subject, result.scope);

    return c.json({ ok: true, refreshRequired: true });
  });

  return routes;
}
