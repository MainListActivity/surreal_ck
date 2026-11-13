import { decodeJwt } from "jose";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requireOidc } from "../middleware/oidc";
import type { IdpTokenScopeAdapter } from "../workspaces/idp-scope-adapter";
import type { WorkspaceScopeModule } from "../workspaces/workspace-scope";

function readWorkspaceTarget(body: unknown): { workspaceSlug?: string; dbName?: string } {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const workspaceSlug = typeof record.workspaceSlug === "string" ? record.workspaceSlug.trim() : undefined;
  const dbName = typeof record.dbName === "string" ? record.dbName.trim() : undefined;
  return {
    ...(workspaceSlug ? { workspaceSlug } : {}),
    ...(dbName ? { dbName } : {}),
  };
}

/** 只读解码 IdP 刚签发的 token 做防御性比对；验签由数据库 / 客户端 JWKS 完成。 */
function readIssuedClaims(token: string): Record<string, unknown> | null {
  try {
    return decodeJwt(token) as Record<string, unknown>;
  } catch {
    return null;
  }
}

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
      } catch (e) {
        // 不打印原始 error、不放进响应 details：上游 message 可能携带 token。
        console.error("[session] idp scope exchange failed", {
          scope: result.scope,
          error: e instanceof Error ? e.name : typeof e,
        });
        throw new HttpError(502, "idp-scope-exchange-failed", "IdP token scope exchange failed");
      }

      return c.json({
        ok: true,
        accessToken: scopeToken.accessToken,
        expiresIn: scopeToken.expiresIn,
      });
    })
    // 原生客户端协作专用：把当前主体在同一 workspace 内降为 participant RECORD 会话，
    // 让信令 `sender = $auth.id` 绑定到其本人 user 行。不是通用「申请任意 ac」接口，
    // 也不改变 switch-workspace 对管理员仍签 admin 的默认行为。
    .post("/api/session/collaboration-scope", requireUser(), async (c) => {
      const body = await c.req.json().catch(() => null);
      if (body && typeof body === "object" && "ac" in body && (body as { ac?: unknown }).ac !== "participant") {
        throw new HttpError(400, "collaboration-scope-access-invalid", "Only participant collaboration scope is available");
      }
      const target = readWorkspaceTarget(body);
      if (!target.workspaceSlug && !target.dbName) {
        throw new HttpError(400, "collaboration-scope-target-required", "workspaceSlug or dbName is required");
      }

      const user = c.var.user;
      const currentAc = user.raw.ac;
      const currentDb = user.raw.db;
      const currentExp = user.raw.exp;
      if ((currentAc !== "admin" && currentAc !== "participant") || typeof currentDb !== "string") {
        throw new HttpError(403, "collaboration-scope-workspace-not-selected", "Select the workspace before requesting collaboration scope");
      }
      if (typeof currentExp !== "number" || !Number.isFinite(currentExp)) {
        throw new HttpError(401, "oidc-claim-invalid", "Bearer token claims are invalid");
      }

      const result = await workspaceScope.resolveCollaborationScope({
        subject: user.subject,
        ...target,
      });
      if (result.kind === "forbidden") {
        throw new HttpError(403, "workspace-forbidden", "Workspace is not accessible");
      }
      if (result.kind === "member-missing") {
        throw new HttpError(409, "collaboration-member-missing", "No active human member record for this subject");
      }
      // 只降级当前已选 workspace；不允许借此跨库换票。
      if (result.scope.db !== currentDb) {
        throw new HttpError(403, "collaboration-scope-workspace-not-selected", "Select the workspace before requesting collaboration scope");
      }

      let scopeToken;
      try {
        scopeToken = await idpTokenScopeAdapter.updateUserScope({
          subjectToken: user.rawToken,
          scope: result.scope,
        });
      } catch (e) {
        console.error("[session] idp collaboration scope exchange failed", {
          scope: result.scope,
          error: e instanceof Error ? e.name : typeof e,
        });
        throw new HttpError(502, "idp-scope-exchange-failed", "IdP token scope exchange failed");
      }

      const issued = readIssuedClaims(scopeToken.accessToken);
      if (
        !issued
        || issued.sub !== user.subject
        || issued.db !== result.scope.db
        || issued.ac !== "participant"
        || typeof issued.exp !== "number"
        || issued.exp > currentExp
      ) {
        console.error("[session] idp collaboration scope token rejected", { scope: result.scope });
        throw new HttpError(502, "idp-scope-exchange-failed", "IdP token scope exchange failed");
      }

      return c.json({
        ok: true,
        accessToken: scopeToken.accessToken,
        expiresIn: scopeToken.expiresIn,
      });
    });
}
