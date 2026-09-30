import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requireOidc } from "../middleware/oidc";
import type { EmployeeLifecycle, EmployeeLifecycleResult } from "../../ai/office/employee-lifecycle";

/**
 * 虚拟员工生命周期 endpoint（VER02）。
 *
 * scope 规则：目标 workspace 必须与调用者 OIDC token 的 db/ac 一致——
 * `db` claim 等于目标库名且 `ac === "admin"`；participant 或别的 workspace
 * token 一律 403，请求体不再被信任解析之外的东西。
 * 响应只含员工视图（id/subject/显示名/状态），绝不带 secret、token、root 凭证。
 */

const REQUEST_KEY_PATTERN = /^[a-zA-Z0-9:_-]{8,200}$/;
// 线上既有 office_role key 含连字符（project-manager / data-analyst）。
const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,62}$/i;

function resultToResponse(result: Exclude<EmployeeLifecycleResult, { kind: "ok" }>): HttpError {
  switch (result.kind) {
    case "caller-denied":
      return new HttpError(403, "employee-caller-denied", "调用者会话未被目标工作区接受");
    case "workspace-not-found":
      return new HttpError(404, "workspace-not-found", "Workspace does not exist or is not active");
    case "employee-not-found":
      return new HttpError(404, "employee-not-found", "Employee does not exist in this workspace");
    case "not-employee":
      return new HttpError(400, "employee-not-virtual", "目标记录不是虚拟员工");
    case "role-not-found":
      return new HttpError(400, "employee-role-not-found", "office_role key 不存在");
    case "invalid-transition":
      return new HttpError(409, "employee-invalid-transition", `员工当前状态 ${result.status} 不允许该操作`);
    case "employee-id-invalid":
      return new HttpError(400, "employee-id-invalid", "员工 id 格式不合法");
  }
}

/** token 的 db/ac scope 必须与目标 workspace 一致且为 admin。 */
function assertAdminScope(user: AppBindings["Variables"]["user"], dbName: string): void {
  const raw = user.raw as { db?: unknown; ac?: unknown };
  if (raw.db !== dbName || raw.ac !== "admin") {
    throw new HttpError(403, "employee-scope-mismatch", "需要目标工作区的 admin 身份");
  }
}

export function createEmployeeRoutes(input: {
  lifecycle: EmployeeLifecycle;
  resolveWorkspace: (slug: string) => Promise<{ dbName: string } | null>;
  requireUser?: () => MiddlewareHandler<AppBindings>;
}): Hono<AppBindings> {
  const requireUser = input.requireUser ?? requireOidc;
  const routes = new Hono<AppBindings>();

  async function scopedDb(c: {
    var: AppBindings["Variables"];
    req: { param(name: string): string };
  }): Promise<string> {
    const workspace = await input.resolveWorkspace(c.req.param("slug"));
    if (!workspace) {
      throw new HttpError(404, "workspace-not-found", "Workspace does not exist or is not active");
    }
    assertAdminScope(c.var.user, workspace.dbName);
    return workspace.dbName;
  }

  routes.post("/api/workspaces/:slug/employees", requireUser(), async (c) => {
    await scopedDb(c);
    const body = await c.req.json().catch(() => null);
    const requestKey = typeof body?.requestKey === "string" ? body.requestKey.trim() : "";
    if (!REQUEST_KEY_PATTERN.test(requestKey)) {
      throw new HttpError(400, "employee-request-key-invalid", "requestKey 需要 8-200 位安全字符");
    }
    const displayName = typeof body?.displayName === "string" && body.displayName.trim()
      ? body.displayName.trim().slice(0, 100)
      : undefined;
    const roleKey = typeof body?.roleKey === "string" && body.roleKey.trim()
      ? body.roleKey.trim()
      : undefined;
    if (roleKey !== undefined && !NAME_PATTERN.test(roleKey)) {
      throw new HttpError(400, "employee-role-key-invalid", "roleKey 格式不合法");
    }

    const result = await input.lifecycle.provision({
      slug: c.req.param("slug"),
      callerToken: c.var.user.rawToken,
      requestKey,
      ...(displayName ? { displayName } : {}),
      ...(roleKey ? { roleKey } : {}),
    });
    if (result.kind !== "ok") throw resultToResponse(result);
    return c.json({ ok: true, created: result.created, employee: result.employee });
  });

  for (const action of ["pause", "resume", "retire"] as const) {
    routes.post(`/api/workspaces/:slug/employees/:employeeKey/${action}`, requireUser(), async (c) => {
      await scopedDb(c);
      const result = await input.lifecycle[action](
        c.req.param("slug"),
        c.req.param("employeeKey"),
        c.var.user.rawToken,
      );
      if (result.kind !== "ok") throw resultToResponse(result);
      return c.json({
        ok: true,
        employee: result.employee,
        ...(result.credentialsExpireBy ? { credentialsExpireBy: result.credentialsExpireBy } : {}),
      });
    });
  }

  return routes;
}
