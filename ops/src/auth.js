import { UserManager, WebStorageStateStore } from "oidc-client-ts";

export const authConfig = {
  issuer: (import.meta.env.VITE_OPS_OIDC_ISSUER || "").replace(/\/$/u, ""),
  clientId: import.meta.env.VITE_OPS_OIDC_CLIENT_ID || "",
  audience: import.meta.env.VITE_OPS_OIDC_AUDIENCE || "",
  apiBase: (import.meta.env.VITE_OPS_API_BASE_URL || "/api").replace(/\/$/u, ""),
  redirectUri: import.meta.env.VITE_OPS_OIDC_REDIRECT_URI || `${window.location.origin}/auth/callback.html`,
};

export function createOpsUserManager() {
  if (!authConfig.issuer || !authConfig.clientId) return null;
  const tokenEndpoint = new URL(`${authConfig.apiBase}/auth/ops/token`, window.location.origin).href;
  const jwksUri = new URL(`${authConfig.apiBase}/auth/ops/jwks`, window.location.origin).href;
  return new UserManager({
    authority: authConfig.issuer,
    client_id: authConfig.clientId,
    redirect_uri: authConfig.redirectUri,
    post_logout_redirect_uri: window.location.origin,
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
