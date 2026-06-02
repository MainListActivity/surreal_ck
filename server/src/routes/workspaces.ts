import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requireOidc } from "../middleware/oidc";
import type { WorkspaceCreator } from "../workspaces/create-workspace";
import type { WorkspaceScopeModule } from "../workspaces/workspace-scope";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

// 注意：链式 .post() 并让返回类型被推导（不要标 `: Hono<AppBindings>`，
// 也不要先 `const routes` 再逐条 in-place 注册），否则 /api/workspaces 的
// schema 会被丢弃，web 端 hc<AppType> 拿不到该 path（D2-05 的同款坑）。
export function createWorkspaceRoutes(
  workspaceCreator: WorkspaceCreator,
  workspaceScope: WorkspaceScopeModule,
  requireUser: () => MiddlewareHandler<AppBindings> = requireOidc,
) {
  return new Hono<AppBindings>().post("/api/workspaces", requireUser(), async (c) => {
    const body = await c.req.json().catch(() => null);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const slug = typeof body?.slug === "string" ? body.slug.trim().toLowerCase() : "";

    if (!name) {
      throw new HttpError(400, "workspace-name-required", "name is required");
    }
    if (!SLUG_PATTERN.test(slug)) {
      throw new HttpError(400, "workspace-slug-invalid", "slug must be 1-40 lowercase alphanumeric or hyphen characters");
    }
    const { canCreate } = await workspaceScope.listWorkspaces({ subject: c.var.user.subject });
    if (!canCreate) {
      throw new HttpError(403, "workspace-create-forbidden", "Workspace creation is not allowed for this user");
    }

    const result = await workspaceCreator.createWorkspace({
      subject: c.var.user.subject,
      subjectToken: c.var.user.rawToken,
      email: c.var.user.email ?? "",
      name,
      slug,
    });

    if (result.kind === "slug-conflict") {
      throw new HttpError(409, "workspace-slug-conflict", "Workspace slug already exists");
    }

    if (result.kind === "scope-update-failed") {
      throw new HttpError(502, "scope-update-failed", "Workspace created but token scope update failed; retry switch-workspace", {
        slug: result.slug,
        dbName: result.dbName,
      });
    }

    return c.json({
      slug: result.slug,
      dbName: result.dbName,
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
    });
  });
}
