import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requireOidc } from "../middleware/oidc";
import type { WorkspaceCreator } from "../workspaces/create-workspace";
import {
  createWorkspaceSettingsManager,
  type WorkspaceSettingsManager,
} from "../workspaces/workspace-settings-manager";
import type { WorkspaceScopeModule } from "../workspaces/workspace-scope";

const MAX_WORKSPACE_NAME_LENGTH = 80;

function workspaceRenameErrorToHttp(kind: "forbidden" | "workspace-not-found"): HttpError {
  switch (kind) {
    case "forbidden":
      return new HttpError(403, "workspace-rename-forbidden", "Only a workspace admin can rename the workspace");
    case "workspace-not-found":
      return new HttpError(404, "workspace-not-found", "Workspace does not exist or is not active");
  }
}

// 注意：链式 .post() 并让返回类型被推导（不要标 `: Hono<AppBindings>`，
// 也不要先 `const routes` 再逐条 in-place 注册），否则 /api/workspaces 的
// schema 会被丢弃，web 端 hc<AppType> 拿不到该 path（D2-05 的同款坑）。
export function createWorkspaceRoutes(
  _workspaceCreator: WorkspaceCreator,
  _workspaceScope: WorkspaceScopeModule,
  requireUser: () => MiddlewareHandler<AppBindings> = requireOidc,
  workspaceSettingsManager: WorkspaceSettingsManager = createWorkspaceSettingsManager(),
) {
  return new Hono<AppBindings>()
    .post("/api/workspaces", requireUser(), async c => {
      c.status(409);
      return c.json({ error: { code: "workspace-commercial-source-required", message: "新工作区需要有效商业来源；请使用显式 Pro 试用入口或联系计费管理员" } });
    })
    .patch("/api/workspaces/:slug", requireUser(), async (c) => {
      const slug = c.req.param("slug");
      const body = await c.req.json().catch(() => null);
      const name = typeof body?.name === "string" ? body.name.trim() : "";

      if (!name || name.length > MAX_WORKSPACE_NAME_LENGTH) {
        throw new HttpError(400, "workspace-name-invalid", "name must be 1-80 characters");
      }

      const result = await workspaceSettingsManager.renameWorkspace({
        callerSubject: c.var.user.subject,
        slug,
        name,
      });

      if (result.kind !== "renamed") {
        throw workspaceRenameErrorToHttp(result.kind);
      }

      return c.json({ ok: true });
    });
}
