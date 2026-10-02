import { UserManager, WebStorageStateStore } from "oidc-client-ts";

export const authConfig = {
  issuer: (import.meta.env.VITE_OPS_OIDC_ISSUER || "").replace(/\/$/u, ""),
  clientId: import.meta.env.VITE_OPS_OIDC_CLIENT_ID || "",
  audience: import.meta.env.VITE_OPS_OIDC_AUDIENCE || "",
  apiBase: (import.meta.env.VITE_OPS_API_BASE_URL || "/api").replace(/\/$/u, ""),
  redirectUri:
    import.meta.env.VITE_OPS_OIDC_REDIRECT_URI ||
    new URL("auth/callback.html", window.location.origin + import.meta.env.BASE_URL).href,
};

/**
 * 运营登出：清本地会话，并经同源窄代理按 RFC 7009 向 IdP 撤销
 * access/refresh token。ma_hono 无 end_session 端点，撤销是 IdP 侧
 * 可达的最强登出语义；撤销失败不阻断回跳（本地会话已清）。
 */
export async function signOutOps(userManager, user) {
  const tokens = [
    [user?.access_token, "access_token"],
    [user?.refresh_token, "refresh_token"],
  ];
  try {
    await userManager?.removeUser();
  } finally {
    for (const [token, hint] of tokens) {
      if (!token) continue;
      try {
        await fetch(`${authConfig.apiBase}/auth/ops/revoke`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token,
            token_type_hint: hint,
            client_id: authConfig.clientId,
          }),
        });
      } catch {
        // 本地会话已清；撤销失败仅意味着 token 待自然过期。
      }
    }
  }
}

export function createOpsUserManager() {
  if (!authConfig.issuer || !authConfig.clientId) return null;
  const tokenEndpoint = new URL(`${authConfig.apiBase}/auth/ops/token`, window.location.origin).href;
  const jwksUri = new URL(`${authConfig.apiBase}/auth/ops/jwks`, window.location.origin).href;
  return new UserManager({
    authority: authConfig.issuer,
    client_id: authConfig.clientId,
    redirect_uri: authConfig.redirectUri,
    post_logout_redirect_uri: window.location.origin + import.meta.env.BASE_URL,
    response_type: "code",
    scope: "openid",
    filterProtocolClaims: true,
    loadUserInfo: false,
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    extraQueryParams: authConfig.audience ? { resource: authConfig.audience } : undefined,
    // IdP discovery 未开放浏览器 CORS；授权仍直达 IdP，token/JWKS 走同源窄代理。
    metadata: {
      issuer: authConfig.issuer,
      authorization_endpoint: `${authConfig.issuer}/authorize`,
      token_endpoint: tokenEndpoint,
      jwks_uri: jwksUri,
    },
  });
}
