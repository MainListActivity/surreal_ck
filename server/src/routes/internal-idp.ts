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

    // 扁平对象：字段名与 IdP 端各 hook-claim 的 hookField 约定一致
    // （db / ac / can_create_workspace）。一次登录一次 hook，多个 claim 复用本对象。
    return c.json({
      db: result.scope.db,
      ac: result.scope.ac,
      can_create_workspace: result.canCreateWorkspace,
    });
  });

  return routes;
}
