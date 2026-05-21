import type { MiddlewareHandler } from "hono";
import { JWTClaimValidationFailed, JWTExpired } from "jose/errors";
import { HttpError } from "../http-error";
import type { AppBindings } from "../hono-types";
import { verifyOidcToken } from "../oidc/verify";

function toOidcHttpError(error: unknown): HttpError {
  if (error instanceof JWTExpired) {
    return new HttpError(401, "oidc-expired", "Bearer token is expired");
  }

  if (error instanceof JWTClaimValidationFailed) {
    if (error.claim === "aud") {
      return new HttpError(401, "oidc-audience-invalid", "Bearer token audience is invalid");
    }
    if (error.claim === "iss") {
      return new HttpError(401, "oidc-issuer-invalid", "Bearer token issuer is invalid");
    }
    return new HttpError(401, "oidc-claim-invalid", "Bearer token claims are invalid");
  }

  return new HttpError(401, "oidc-invalid", "Invalid bearer token");
}

export function requireOidc(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const authorization = c.req.header("authorization") ?? "";
    const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];

    if (!token) {
      throw new HttpError(401, "oidc-missing", "Missing bearer token");
    }

    try {
      c.set("user", await verifyOidcToken(token));
    } catch (error) {
      throw toOidcHttpError(error);
    }

    await next();
  };
}
