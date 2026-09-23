import type { MiddlewareHandler } from "hono";
import { JWTClaimValidationFailed, JWTExpired } from "jose/errors";
import type { PlatformOperatorCapability } from "@surreal-ck/shared/native-quota";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { env } from "../env";
import { getRootDatabaseSession } from "../db/root-connection";
import { introspectOidcAccessToken, type OidcTokenActivityChecker } from "../oidc/introspection";
import { verifyOidcToken } from "../oidc/verify";

export type PlatformOperatorAuth = Readonly<{
  subject: string;
  kind?: "human" | "agent";
  capabilities: readonly PlatformOperatorCapability[];
}>;

export type PlatformOperatorCapabilityReader = {
  getCapabilities(subject: string): Promise<readonly PlatformOperatorCapability[]>;
  getKind?(subject: string): Promise<"human" | "agent" | null>;
};

type Queryable = { query(sql: string, params?: Record<string, unknown>): Promise<unknown> };

function rows(result: unknown): unknown[] {
  if (!Array.isArray(result) || !Array.isArray(result[0])) return [];
  return result[0];
}

function configuredOpsAudience(): string {
  if (env.OIDC_OPS_AUDIENCE) return env.OIDC_OPS_AUDIENCE;
  if (env.NODE_ENV !== "production") return env.OIDC_AUDIENCE;
  throw new HttpError(503, "oidc-ops-audience-not-configured", "运营端 audience 未配置");
}

function bearerToken(authorization: string | undefined): string {
  const token = authorization?.match(/^Bearer\s+(.+)$/iu)?.[1];
  if (!token) throw new HttpError(401, "oidc-missing", "Missing bearer token");
  return token;
}

function oidcError(error: unknown): HttpError {
  if (error instanceof JWTExpired) return new HttpError(401, "oidc-expired", "Bearer token is expired");
  if (error instanceof JWTClaimValidationFailed) {
    if (error.claim === "aud") return new HttpError(401, "oidc-ops-audience-invalid", "运营端 token audience 无效");
    if (error.claim === "iss") return new HttpError(401, "oidc-issuer-invalid", "Bearer token issuer is invalid");
  }
  return new HttpError(401, "oidc-invalid", "Invalid bearer token");
}

export function createPlatformOperatorCapabilityReader(
  db?: Queryable,
): PlatformOperatorCapabilityReader {
  const getDb = db ? async () => db : () => getRootDatabaseSession("_system");
  return {
    async getKind(subject) {
      const result = await (await getDb()).query(`SELECT kind FROM platform_operator WHERE subject = $subject AND status = "active" LIMIT 1;`, { subject });
      const row = rows(result)[0];
      if (!row || typeof row !== "object" || !("kind" in row)) return null;
      return row.kind === "human" || row.kind === "agent" ? row.kind : null;
    },
    async getCapabilities(subject) {
      const result = await (await getDb()).query(
        `
          SELECT VALUE capability
          FROM platform_operator_capability
          WHERE status = "active"
            AND operator IN (
              SELECT VALUE id
              FROM platform_operator
              WHERE subject = $subject
                AND status = "active"
            );
        `,
        { subject },
      );
      return rows(result).filter((value): value is PlatformOperatorCapability =>
        typeof value === "string" && value.length > 0,
      );
    },
  };
}

/**
 * 运营端与客户 API 使用同一 issuer 但不同 audience；资格在每次请求从
 * platform_operator / capability 重新读取，故禁用或撤销会立即影响旧 token。
 */
export function requirePlatformOperator(
  requiredCapability?: PlatformOperatorCapability,
  options: Readonly<{
    reader?: PlatformOperatorCapabilityReader;
    tokenActivityChecker?: OidcTokenActivityChecker;
  }> = {},
): MiddlewareHandler<AppBindings> {
  const reader = options.reader ?? createPlatformOperatorCapabilityReader();
  const tokenActivityChecker =
    options.tokenActivityChecker ??
    (env.NODE_ENV === "production" ? introspectOidcAccessToken : async () => true);
  return async (c, next) => {
    const token = bearerToken(c.req.header("authorization"));
    let user;
    try {
      user = await verifyOidcToken(token, { audience: configuredOpsAudience() });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw oidcError(error);
    }
    if (!(await tokenActivityChecker(token))) {
      throw new HttpError(401, "oidc-revoked", "Bearer token has been revoked");
    }
    const capabilities = [...await reader.getCapabilities(user.subject)].sort();
    if (capabilities.length === 0) {
      throw new HttpError(403, "platform-operator-inactive", "账号不是有效的平台运营人员");
    }
    if (requiredCapability && !capabilities.includes(requiredCapability)) {
      throw new HttpError(403, "platform-operator-capability-missing", "运营账号没有执行此操作的能力");
    }
    c.set("user", user);
    const kind = await reader.getKind?.(user.subject) ?? undefined;
    c.set("platformOperator", { subject: user.subject, kind, capabilities });
    await next();
  };
}
