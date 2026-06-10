import { env } from "../env";
import type { SurrealTokenScope } from "./workspace-scope";

export type IdpScopeTokenResult = {
  accessToken: string;
  expiresIn: number | null;
};

export interface IdpTokenScopeAdapter {
  updateUserScope(input: {
    subjectToken: string;
    scope: SurrealTokenScope;
  }): Promise<IdpScopeTokenResult>;
}

// IdP 错误响应可能回显 subject_token 或携带 token / secret 字段；
// 进入 error message（进而进入日志）前必须先脱敏。
const SENSITIVE_KEY_PATTERN = /token|secret|password|authorization/i;

function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitive);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : redactSensitive(entry),
      ]),
    );
  }
  return value;
}

export function createIdpTokenScopeAdapter(): IdpTokenScopeAdapter {
  return {
    async updateUserScope({ subjectToken, scope }) {
      if (!env.IDP_SCOPE_API_URL || !env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET) {
        throw new Error("IdP scope adapter is not configured");
      }

      const response = await fetch(env.IDP_SCOPE_API_URL, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${env.OIDC_CLIENT_ID}:${env.OIDC_CLIENT_SECRET}`)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          subject_token: subjectToken,
          claims: {
            db: scope.db,
            ac: scope.ac,
            // SurrealDB system-level roles claim：管理员 → OWNER，其余 → EDITOR。
            RL: scope.ac === "admin" ? ["Owner"] : ["Editor"],
          },
        }),
      });

      const body = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(
          `IdP scope update failed with ${response.status}, ${JSON.stringify(redactSensitive(body))}`,
        );
      }

      if (!body || typeof body !== "object" || typeof (body as { access_token?: unknown }).access_token !== "string") {
        throw new Error("IdP scope update did not return an access token");
      }

      const expiresIn = (body as { expires_in?: unknown }).expires_in;
      return {
        accessToken: (body as { access_token: string }).access_token,
        expiresIn: typeof expiresIn === "number" && Number.isFinite(expiresIn) ? expiresIn : null,
      };
    },
  };
}
