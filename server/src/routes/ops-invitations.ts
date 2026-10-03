import { Hono } from "hono";
import { createOpsInvitationSchema } from "@surreal-ck/shared";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requirePlatformOperator } from "../ops/operator-auth";
import { InviteError, type InviteService } from "../invitations/invite-service";

function fail(error: unknown): never {
  if (!(error instanceof InviteError)) throw error;
  const status = error.code === "invite-conflict" || error.code === "invite-in-progress" || error.code === "invite-slug-taken"
    ? 409
    : error.code === "invite-idp-not-configured" || error.code === "idp-admin-login-failed"
      ? 503
      : error.code.startsWith("idp-admin-")
        ? 502
        : 400;
  throw new HttpError(status, error.code, error.message);
}

/**
 * G2 运营代办开通（ops 控制面）：输入真实邮箱 + 显示名 + 期望 workspace slug，
 * 一条链路完成 IdP 用户开通（幂等复用）→ workspace bootstrap（manual 套餐
 * 分配，不产生付费事实）→ 产品权益绑定（内容访问）→ AI 额度桶授予。
 * 写路径 = subscription.manage（subscription/权益组合操作）；读 = quota.read。
 * activation_url 仅首次响应返回一次，不落审计与日志。
 */
export function createOpsInvitationRoutes(input: {
  service: InviteService;
  requireOperator?: typeof requirePlatformOperator;
}) {
  const requireOperator = input.requireOperator ?? requirePlatformOperator;
  return new Hono<AppBindings>()
    .post("/api/ops/invitations", requireOperator("subscription.manage"), async (c) => {
      const parsed = createOpsInvitationSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new HttpError(400, "invite-invalid-request", "邀请开通请求无效", parsed.error.flatten());
      }
      const operator = c.var.platformOperator;
      try {
        const result = await input.service.provision(
          { subject: operator?.subject ?? "unknown", capabilities: operator?.capabilities ?? [] },
          parsed.data,
        );
        return c.json(result, result.replayed ? 200 : 201);
      } catch (error) {
        return fail(error);
      }
    })
    .get("/api/ops/invitations/:idempotencyKey", requireOperator("quota.read"), async (c) => {
      const result = await input.service.get(c.req.param("idempotencyKey"));
      if (!result) throw new HttpError(404, "invite-not-found", "邀请记录不存在");
      return c.json(result);
    });
}
