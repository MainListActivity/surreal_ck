import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requireOidc } from "../middleware/oidc";
import type {
  OfficeBootstrapResult,
  OfficeRequestWakeResult,
} from "../../ai/office/office-trigger-adapter";

/**
 * 虚拟办公室 bootstrap endpoint（VO02）。
 *
 * 管理员在浏览器里完成 goal/primary_contact 保存后调用本端点：
 * 幂等开岗项目经理并向通用员工 runtime 投递 office-bootstrap 触发。
 * scope 与 employees 路由一致：token 的 db/ac 必须等于目标 workspace 且 ac=admin。
 * 响应只含员工视图与触发终态，绝不带 secret/root 凭证。
 */

export type OfficeBootstrapAction = (
  input: { slug: string; callerToken: string },
) => Promise<OfficeBootstrapResult>;

/**
 * VO03：收件人在浏览器提交 resolution 之后调用本动作唤醒请求员工。
 * resolution 先落库（浏览器直连），本动作只负责"已解决 → 投递触发"的翻译。
 */
export type OfficeRequestWakeAction = (
  input: { slug: string; callerToken: string; notificationId: string },
) => Promise<OfficeRequestWakeResult>;

function resultToResponse(result: Exclude<OfficeBootstrapResult, { kind: "ok" }>): HttpError {
  switch (result.kind) {
    case "workspace-not-found":
      return new HttpError(404, "workspace-not-found", "Workspace does not exist or is not active");
    case "caller-denied":
      return new HttpError(403, "office-caller-denied", "调用者会话未被目标工作区接受");
    case "meta-incomplete":
      return new HttpError(
        409,
        "office-meta-incomplete",
        `office_meta 未就绪：缺少 ${result.missing.join(", ")}`,
      );
    case "provision-failed":
      return new HttpError(409, "office-provision-failed", `项目经理开岗失败：${result.reason}`);
    case "trigger-failed":
      return new HttpError(409, "office-bootstrap-failed", `bootstrap 触发执行失败：${result.error}`);
  }
}

/** token 的 db/ac scope 必须与目标 workspace 一致且为 admin。 */
function assertAdminScope(user: AppBindings["Variables"]["user"], dbName: string): void {
  const raw = user.raw as { db?: unknown; ac?: unknown };
  if (raw.db !== dbName || raw.ac !== "admin") {
    throw new HttpError(403, "office-scope-mismatch", "需要目标工作区的 admin 身份");
  }
}

/** token 的 db scope 必须与目标 workspace 一致（admin/participant 均可唤醒自己收件箱里的请求）。 */
function assertMemberScope(user: AppBindings["Variables"]["user"], dbName: string): void {
  const raw = user.raw as { db?: unknown; ac?: unknown };
  if (raw.db !== dbName || (raw.ac !== "admin" && raw.ac !== "participant")) {
    throw new HttpError(403, "office-scope-mismatch", "需要目标工作区的成员身份");
  }
}

function wakeResultToResponse(
  result: Exclude<OfficeRequestWakeResult, { kind: "ok" }>,
): HttpError {
  switch (result.kind) {
    case "workspace-not-found":
      return new HttpError(404, "workspace-not-found", "Workspace does not exist or is not active");
    case "caller-denied":
      return new HttpError(403, "office-caller-denied", "调用者会话未被目标工作区接受");
    case "not-found":
      return new HttpError(404, "office-request-not-found", "通知不存在或不在你的收件箱");
    case "not-request":
      return new HttpError(409, "office-not-request", "该通知不是人类请求");
    case "unresolved":
      return new HttpError(409, "office-request-unresolved", "请求尚未提交终态");
    case "no-requester":
      return new HttpError(409, "office-request-no-requester", "请求缺少可唤醒的员工");
    case "trigger-failed":
      return new HttpError(409, "office-wake-failed", `唤醒投递失败：${result.error}`);
  }
}

export function createOfficeRoutes(input: {
  bootstrap: OfficeBootstrapAction;
  resolveWorkspace: (slug: string) => Promise<{ dbName: string } | null>;
  wakeRequest?: OfficeRequestWakeAction;
  requireUser?: () => MiddlewareHandler<AppBindings>;
}): Hono<AppBindings> {
  const requireUser = input.requireUser ?? requireOidc;
  const routes = new Hono<AppBindings>();

  routes.post("/api/workspaces/:slug/office/bootstrap", requireUser(), async (c) => {
    const workspace = await input.resolveWorkspace(c.req.param("slug"));
    if (!workspace) {
      throw new HttpError(404, "workspace-not-found", "Workspace does not exist or is not active");
    }
    assertAdminScope(c.var.user, workspace.dbName);

    const result = await input.bootstrap({
      slug: c.req.param("slug"),
      callerToken: c.var.user.rawToken,
    });
    if (result.kind !== "ok") throw resultToResponse(result);
    return c.json({
      ok: true,
      employeeId: result.employeeId,
      outcome: result.outcome,
      triggerId: result.triggerId,
      taskId: result.taskId,
    });
  });

  // VO03：收件人提交终态后唤醒请求员工。resolution 由浏览器直连落库；本端点
  // 只做"已解决 → 投递 office-request-resolved 触发"的翻译，唤醒是幂等的。
  routes.post(
    "/api/workspaces/:slug/office/requests/:notificationId/wake",
    requireUser(),
    async (c) => {
      if (!input.wakeRequest) {
        throw new HttpError(501, "office-wake-unavailable", "唤醒通道未配置");
      }
      const workspace = await input.resolveWorkspace(c.req.param("slug"));
      if (!workspace) {
        throw new HttpError(404, "workspace-not-found", "Workspace does not exist or is not active");
      }
      assertMemberScope(c.var.user, workspace.dbName);

      const result = await input.wakeRequest({
        slug: c.req.param("slug"),
        callerToken: c.var.user.rawToken,
        notificationId: c.req.param("notificationId"),
      });
      if (result.kind !== "ok") throw wakeResultToResponse(result);
      return c.json({ ok: true, outcome: result.outcome, triggerId: result.triggerId });
    },
  );

  return routes;
}
