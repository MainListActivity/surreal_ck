import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requireOidc } from "../middleware/oidc";
import type { IdpTokenScopeAdapter } from "../workspaces/idp-scope-adapter";
import type { WorkspaceScopeModule } from "../workspaces/workspace-scope";

const SESSION_DEBUG_PREFIX = "[DEBUG-ws-session]";

function createDebugTraceId(): string {
  return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function identityForLog(subject: string, email?: string): Record<string, unknown> {
  return {
    subjectTail: subject.slice(-8),
    hasEmail: Boolean(email),
    emailDomain: email?.split("@").at(1) ?? null,
  };
}

function errorForLog(error: unknown): Record<string, unknown> {
  return {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
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
      const debugTraceId = createDebugTraceId();
      const startedAt = Date.now();
      const identity = identityForLog(c.var.user.subject, c.var.user.email);

      console.info(SESSION_DEBUG_PREFIX, "list:start", {
        traceId: debugTraceId,
        ...identity,
      });

      try {
        const { workspaces, canCreate } = await workspaceScope.listWorkspaces({
          subject: c.var.user.subject,
          email: c.var.user.email,
          debugTraceId,
        });

        console.info(SESSION_DEBUG_PREFIX, "list:ok", {
          traceId: debugTraceId,
          durationMs: Date.now() - startedAt,
          workspaceCount: workspaces.length,
          canCreate,
          workspaceSlugs: workspaces.map((workspace) => workspace.slug).slice(0, 20),
          ...identity,
        });

        return c.json({ workspaces, canCreate });
      } catch (error) {
        console.warn(SESSION_DEBUG_PREFIX, "list:failed", {
          traceId: debugTraceId,
          durationMs: Date.now() - startedAt,
          ...identity,
          ...errorForLog(error),
        });
        throw error;
      }
    })
    .post("/api/session/switch-workspace", requireUser(), async (c) => {
      const debugTraceId = createDebugTraceId();
      const startedAt = Date.now();
      const identity = identityForLog(c.var.user.subject, c.var.user.email);
      const body = await c.req.json().catch(() => null);
      const workspaceSlug = typeof body?.workspaceSlug === "string" ? body.workspaceSlug.trim() : undefined;
      const dbName = typeof body?.dbName === "string" ? body.dbName.trim() : undefined;

      console.info(SESSION_DEBUG_PREFIX, "switch:start", {
        traceId: debugTraceId,
        targetKind: workspaceSlug ? "slug" : dbName ? "dbName" : "missing",
        workspaceSlug,
        dbName,
        ...identity,
      });

      if (!workspaceSlug && !dbName) {
        throw new HttpError(400, "switch-workspace-target-required", "workspaceSlug or dbName is required");
      }

      const result = await workspaceScope.switchWorkspace({
        subject: c.var.user.subject,
        email: c.var.user.email,
        ...(workspaceSlug ? { workspaceSlug } : {}),
        ...(dbName ? { dbName } : {}),
      });

      console.info(SESSION_DEBUG_PREFIX, "switch:scope-result", {
        traceId: debugTraceId,
        durationMs: Date.now() - startedAt,
        kind: result.kind,
        scope: result.kind === "switched" ? result.scope : undefined,
        ...identity,
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
