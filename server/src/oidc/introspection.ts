import { env } from "../env";
import { HttpError } from "../http-error";

export type OidcTokenActivityChecker = (token: string) => Promise<boolean>;

function configuredEndpoint(): string {
  return env.OIDC_INTROSPECTION_ENDPOINT ?? `${env.OIDC_ISSUER}/introspect`;
}

/**
 * MCP 是有状态的高权限维护入口。JWT 本地验签后，再让 IdP 确认其尚未被
 * RFC 7009 撤销；上游不可用时故障关闭，避免把撤销退化为一小时等待。
 */
export const introspectOidcAccessToken: OidcTokenActivityChecker = async (token) => {
  if (!env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET) {
    throw new HttpError(503, "oidc-introspection-not-configured", "运营 OAuth 状态校验未配置");
  }

  let response: Response;
  try {
    response = await fetch(configuredEndpoint(), {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${env.OIDC_CLIENT_ID}:${env.OIDC_CLIENT_SECRET}`)}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json"
      },
      body: new URLSearchParams({ token }).toString()
    });
  } catch {
    throw new HttpError(503, "oidc-introspection-unavailable", "运营 OAuth 状态校验暂不可用");
  }

  if (!response.ok) {
    throw new HttpError(503, "oidc-introspection-unavailable", "运营 OAuth 状态校验暂不可用");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new HttpError(503, "oidc-introspection-invalid-response", "运营 OAuth 状态校验响应无效");
  }

  return Boolean(
    body !== null &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      (body as { active?: unknown }).active === true
  );
};
