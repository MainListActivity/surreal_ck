import type { MiddlewareHandler } from "hono";
import { JOSEError, JWKSTimeout, JWTClaimValidationFailed, JWTExpired } from "jose/errors";
import { HttpError } from "../http-error";
import type { AppBindings } from "../hono-types";
import { verifyOidcToken } from "../oidc/verify";
import { describeUpstreamFailure, isNetworkUpstreamFailure } from "../oidc/upstream-fetch";

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
      // 只有上游类失败记录脱敏日志（只含错误名与 causeCode，不含 message/token），
      // 用于诊断 JWKS/连接类故障。jose 的 token 校验错误（签名/畸形/过期/claim，
      // 全是 JOSEError，且都带顶层 code 如 ERR_JWS_INVALID）一律静默：任意未认证
      // 请求都能触发它们，不能用来污染诊断信号。JWKSTimeout 虽是 JOSEError 子类，
      // 但属 JWKS 上游超时，保留记录。
      if (error instanceof JWKSTimeout) {
        console.error("[oidc] bearer verification upstream failure", describeUpstreamFailure(error));
      } else if (!(error instanceof JOSEError)) {
        const failure = describeUpstreamFailure(error);
        if (isNetworkUpstreamFailure(failure)) {
          console.error("[oidc] bearer verification upstream failure", failure);
        }
      }
      throw toOidcHttpError(error);
    }

    await next();
  };
}
