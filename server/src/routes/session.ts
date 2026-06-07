import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requireOidc } from "../middleware/oidc";
import type { IdpTokenScopeAdapter } from "../workspaces/idp-scope-adapter";
import type { WorkspaceScopeModule } from "../workspaces/workspace-scope";

// 注意：链式 .get().post() 并让返回类型被推导（不要标 `: Hono<AppBindings>`），
// 这样 createApp 链上 hc<AppType> 才能拿到 /api/session/* 的端到端类型。
export function createSessionRoutes(
  workspaceScope: WorkspaceScopeModule,
  idpTokenScopeAdapter: IdpTokenScopeAdapter,
  requireUser: () => MiddlewareHandler<AppBindings> = requireOidc,
) {
  return new Hono<AppBindings>()
    .get("/api/session/workspaces", requireUser(), async (c) => {
      const { workspaces, canCreate } = await workspaceScope.listWorkspaces({
        subject: c.var.user.subject,
        email: c.var.user.email,
      });

      return c.json({ workspaces, canCreate });
    })
    .post("/api/session/switch-workspace", requireUser(), async (c) => {
      const body = await c.req.json().catch(() => null);
      const workspaceSlug = typeof body?.workspaceSlug === "string" ? body.workspaceSlug.trim() : undefined;
      const dbName = typeof body?.dbName === "string" ? body.dbName.trim() : undefined;

      if (!workspaceSlug && !dbName) {
        throw new HttpError(400, "switch-workspace-target-required", "workspaceSlug or dbName is required");
      }

      const result = await workspaceScope.switchWorkspace({
        subject: c.var.user.subject,
        email: c.var.user.email,
        ...(workspaceSlug ? { workspaceSlug } : {}),
        ...(dbName ? { dbName } : {}),
      });

      if (result.kind === "forbidden") {
        throw new HttpError(403, "workspace-forbidden", "Workspace is not accessible");
      }

      if (result.kind === "drift") {
        throw new HttpError(409, "workspace-user-drift", "Workspace user drift detected");
      }

      let scopeToken;
      try {
        scopeToken = await idpTokenScopeAdapter.updateUserScope({
          subjectToken: c.var.user.rawToken,
          scope: result.scope,
        });
      } catch(e) {
          console.log(e)
        throw new HttpError(502, "idp-scope-exchange-failed", "IdP token scope exchange failed", e);
      }

      return c.json({
        ok: true,
        accessToken: scopeToken.accessToken,
        expiresIn: scopeToken.expiresIn,
      });
    });
}
