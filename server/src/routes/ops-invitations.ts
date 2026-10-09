import { Hono } from "hono";
import { createOpsInvitationSchema } from "@surreal-ck/shared";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requirePlatformOperator } from "../ops/operator-auth";
import { InviteError, type InviteService } from "../invitations/invite-service";

function fail(error: unknown): never {
  if (!(error instanceof InviteError)) throw error;
  const status = error.code === "invite-conflict" || error.code === "invite-in-progress" || error.code === "invite-slug-taken"
    || error.code === "invite-resend-while-processing" || error.code === "invite-resend-invalid-state"
    || error.code === "invite-already-activated" || error.code === "invite-idp-user-missing"
    ? 409
    : error.code === "invite-idp-not-configured"
      ? 503
      : error.code.startsWith("idp-admin-") || error.code === "invite-resend-no-url"
        ? 502
        : 400;
  throw new HttpError(status, error.code, error.message);
}

/**
 * G2 运营代办开通（ops 控制面）：输入真实邮箱 + 显示名 + 期望 workspace slug，
 * 一条链路完成 IdP 用户开通（幂等复用）→ workspace bootstrap（manual 套餐
 * 分配，不产生付费事实）→ 产品权益绑定（内容访问）→ AI 额度桶授予。
 * 写路径 = subscription.manage（subscription/权益组合操作）；读 = quota.read。
 *
 * 异步契约：POST 在同步窗口内完成则返回 201/200 + 一次性 activation_url；
 * 超时返回 202/200 status=processing（任务继续在后台执行），调用方轮询
 * GET 至 completed，再经 POST .../collect-delivery 一次性收取激活链接。
 * activation_url 不落审计与日志，仅首次成功收取返回。
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
        return c.json(
          result,
          result.status === "processing" ? (result.replayed ? 200 : 202) : result.replayed ? 200 : 201,
        );
      } catch (error) {
        return fail(error);
      }
    })
    .get("/api/ops/invitations/:idempotencyKey", requireOperator("quota.read"), async (c) => {
      const result = await input.service.get(c.req.param("idempotencyKey"));
      if (!result) throw new HttpError(404, "invite-not-found", "邀请记录不存在");
      return c.json(result);
    })
    .post("/api/ops/invitations/:idempotencyKey/collect-delivery", requireOperator("subscription.manage"), async (c) => {
      const result = await input.service.collect(c.req.param("idempotencyKey"));
      if (!result) throw new HttpError(404, "invite-not-found", "邀请记录不存在");
      return c.json(result);
    })
    // 激活链接重签发（断链/24h 过期补救）：向 IdP 重铸一次性激活链接并暂存回行，
    // 收取仍走 collect-delivery。重放去重：未收取或 24h 有效期内不重复铸链。
    .post("/api/ops/invitations/:idempotencyKey/resend", requireOperator("subscription.manage"), async (c) => {
      const operator = c.var.platformOperator;
      try {
        const result = await input.service.resend(
          { subject: operator?.subject ?? "unknown", capabilities: operator?.capabilities ?? [] },
          c.req.param("idempotencyKey"),
        );
        if (!result) throw new HttpError(404, "invite-not-found", "邀请记录不存在");
        return c.json(result);
      } catch (error) {
        return fail(error);
      }
    });
}
