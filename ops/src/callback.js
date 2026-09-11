import { UserManager, WebStorageStateStore } from "oidc-client-ts";

const manager = new UserManager({
  authority: import.meta.env.VITE_OPS_OIDC_ISSUER,
  client_id: import.meta.env.VITE_OPS_OIDC_CLIENT_ID,
  redirect_uri: `${window.location.origin}/auth/callback.html`,
  post_logout_redirect_uri: window.location.origin,
  response_type: "code",
  scope: "openid",
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
});

try {
  await manager.signinRedirectCallback();
  window.location.replace("/");
} catch (error) {
  document.body.textContent = error instanceof Error ? `运营登录失败：${error.message}` : "运营登录失败";
}
