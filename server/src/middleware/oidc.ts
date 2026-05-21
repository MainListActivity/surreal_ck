import type { MiddlewareHandler } from "hono";
import { HttpError } from "../http-error";
import type { AppBindings } from "../hono-types";
import { verifyOidcToken } from "../oidc/verify";

export function requireOidc(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const authorization = c.req.header("authorization") ?? "";
    const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];

    if (!token) {
      throw new HttpError(401, "oidc-missing", "Missing bearer token");
    }

    try {
      c.set("user", await verifyOidcToken(token));
    } catch {
      throw new HttpError(401, "oidc-invalid", "Invalid bearer token");
    }

    await next();
  };
}
