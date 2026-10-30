import type { MiddlewareHandler } from "hono";
import { JWTClaimValidationFailed, JWTExpired } from "jose/errors";
import { HttpError } from "../http-error";
import type { AppBindings } from "../hono-types";
import { verifyOidcToken } from "../oidc/verify";
import { describeUpstreamFailure } from "../oidc/upstream-fetch";

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
      // 上游类失败（JWKS 拉取超时/网络错误）此前完全无日志，登录侧
      // UND_ERR_CONNECT_TIMEOUT 这类故障无法诊断。只记录错误名与 cause.code，
      // 不记录 message（可能含 token）；普通过期/claim/签名错误保持静默。
      if (!(error instanceof JWTExpired) && !(error instanceof JWTClaimValidationFailed)) {
        const failure = describeUpstreamFailure(error);
        if (failure.timeout || failure.causeCode !== null || failure.name.startsWith("JWKS")) {
          console.error("[oidc] bearer verification upstream failure", failure);
        }
      }
      throw toOidcHttpError(error);
    }

    await next();
  };
}
