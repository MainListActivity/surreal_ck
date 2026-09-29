import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { ContentReaderExchangeSuccess, ContentReaderFailure } from "@surreal-ck/shared";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requireOidc } from "../middleware/oidc";

export type ContentReaderExchangeHandler = (
  caller: AppBindings["Variables"]["user"],
  body: unknown,
) => Promise<ContentReaderExchangeSuccess | ContentReaderFailure>;

function statusFor(error: ContentReaderFailure["error"]): number {
  // Cloudflare 会把源站 HTTP 502 换成 origin_bad_gateway 并丢掉 JSON。
  // 换票失败必须仍是完整应用响应，所以用 503。
  if (error === "idp_rejected" || error === "invalid_lifetime") return 503;
  if (error === "client_authority_rejected" || error === "action_denied") return 400;
  return 403;
}

export function createContentReaderRoutes(input: {
  exchange: ContentReaderExchangeHandler;
  requireUser?: () => MiddlewareHandler<AppBindings>;
}) {
  const requireUser = input.requireUser ?? requireOidc;
  return new Hono<AppBindings>().post("/api/session/content-reader", requireUser(), async (c) => {
    const body = await c.req.json().catch(() => null);
    const result = await input.exchange(c.var.user, body);
    if ("ok" in result) {
      throw new HttpError(
        statusFor(result.error),
        `content-reader-${result.error}`,
        "内容读取凭证被拒绝",
        result.idpError === undefined ? undefined : { idpError: result.idpError },
      );
    }
    return c.json(result);
  });
}
