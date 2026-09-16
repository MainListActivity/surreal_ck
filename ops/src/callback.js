import { createOpsUserManager } from "./auth.js";

const manager = createOpsUserManager();

try {
  if (!manager) throw new Error("运营端 OIDC 未配置");
  await manager.signinRedirectCallback();
  window.location.replace("/");
} catch (error) {
  document.body.textContent = error instanceof Error ? `运营登录失败：${error.message}` : "运营登录失败";
}
