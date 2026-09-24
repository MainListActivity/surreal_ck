import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requireOidc } from "../middleware/oidc";

export function createLegalContentRoutes(input: Readonly<{
  requireUser?: () => MiddlewareHandler<AppBindings>;
}>) {
  const requireUser = input.requireUser ?? requireOidc;

  return new Hono<AppBindings>().post("/api/legal/search", requireUser(), async (c) => {
    await c.req.json().catch(() => {
      throw new HttpError(400, "invalid_request", "请求体必须是合法 JSON");
    });
    // A caller-bound content session and entitlement projection are required.
    throw new HttpError(503, "content_authorization_unavailable", "平台法律内容授权服务尚未就绪");
  });
}
