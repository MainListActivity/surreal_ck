import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { JWTClaimValidationFailed, JWTExpired } from "jose/errors";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { verifyOidcToken } from "../oidc/verify";
import { requireOidc } from "../middleware/oidc";
import { requirePlatformOperator } from "../ops/operator-auth";
import { discoverEventSchema, discoverQuerySchema, discoverRebuildSchema } from "@surreal-ck/shared";
import { DiscoverError, type DiscoverService } from "../discover/service";

/**
 * LCA11 公开发现路由。
 * /overview、/query、/events 面向未登录访客：只返回投影内许可放行的
 * 安全元数据与策划示例，不鉴权但也不泄露任何受限内容。
 * /evaluate 需要成员 token；/ops/discover/rebuild 需要 content.publish 运营能力。
 */

/** 可选身份：带 Bearer 就验证并塞 user；没带按访客放行。 */
function optionalOidc(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const token = (c.req.header("authorization") ?? "").match(/^Bearer\s+(.+)$/iu)?.[1];
    if (token) {
      try {
        c.set("user", await verifyOidcToken(token));
      } catch (error) {
        if (error instanceof JWTExpired) throw new HttpError(401, "oidc-expired", "Bearer token is expired");
        if (error instanceof JWTClaimValidationFailed) throw new HttpError(401, "oidc-invalid", "Bearer token claims are invalid");
        throw new HttpError(401, "oidc-invalid", "Invalid bearer token");
      }
    }
    await next();
  };
}

async function jsonBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(400, "invalid_request", "请求体必须是合法 JSON");
  }
}

function serviceError(error: unknown): never {
  if (error instanceof DiscoverError) {
    const status =
      error.code === "not-member" ? 403
      : error.code === "workspace-inactive" ? 403
      : error.code === "entitlement-absent" ? 403
      : 503;
    throw new HttpError(status, error.code, error.message);
  }
  throw error;
}

export function createDiscoverRoutes(input: {
  service: DiscoverService;
  requireUser?: () => MiddlewareHandler<AppBindings>;
  requireOperator?: () => MiddlewareHandler<AppBindings>;
}) {
  const requireUser = input.requireUser ?? requireOidc;
  const requireOperator = input.requireOperator ?? (() => requirePlatformOperator("content.publish"));

  return new Hono<AppBindings>()
    .get("/api/discover/overview", optionalOidc(), async (c) => {
      try {
        return c.json(await input.service.overview());
      } catch (error) {
        return serviceError(error);
      }
    })
    .post("/api/discover/query", optionalOidc(), async (c) => {
      const parsed = discoverQuerySchema.safeParse(await jsonBody(c));
      if (!parsed.success) throw new HttpError(400, "invalid_request", "question 必须是 1-500 字符的字符串");
      try {
        return c.json(await input.service.publicQuery(parsed.data.question));
      } catch (error) {
        return serviceError(error);
      }
    })
    .post("/api/discover/evaluate", requireUser(), async (c) => {
      const parsed = discoverQuerySchema.safeParse(await jsonBody(c));
      if (!parsed.success) throw new HttpError(400, "invalid_request", "question 必须是 1-500 字符的字符串");
      const user = c.var.user;
      const workspaceDb = typeof user.raw?.db === "string" ? user.raw.db : "";
      if (!workspaceDb) throw new HttpError(403, "not-member", "当前会话没有关联工作区");
      try {
        return c.json(await input.service.evaluateMember({
          question: parsed.data.question,
          subject: user.subject,
          workspaceDb,
        }));
      } catch (error) {
        return serviceError(error);
      }
    })
    .post("/api/discover/events", optionalOidc(), async (c) => {
      const parsed = discoverEventSchema.safeParse(await jsonBody(c));
      if (!parsed.success) throw new HttpError(400, "invalid_request", "事件字段不符合结构化契约");
      const user = c.var.user;
      const workspaceDb = typeof user?.raw?.db === "string" ? user.raw.db : null;
      await input.service.recordEvent(user ? "member" : "visitor", parsed.data, workspaceDb);
      return c.json({ ok: true });
    })
    .post("/api/ops/discover/rebuild", requireOperator(), async (c) => {
      const parsed = discoverRebuildSchema.safeParse(await jsonBody(c));
      if (!parsed.success) throw new HttpError(400, "invalid_request", "重建请求不符合契约");
      const operator = c.var.platformOperator;
      if (!operator) throw new HttpError(403, "platform-operator-required", "需要平台运营身份");
      try {
        return c.json(await input.service.rebuildProjection(operator.subject, parsed.data));
      } catch (error) {
        return serviceError(error);
      }
    });
}
