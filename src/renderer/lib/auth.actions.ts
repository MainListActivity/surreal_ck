import { rpc } from "./rpc";
import { applyAuthState } from "./auth.svelte";

export function login() {
  // fire-and-forget：主进程异步完成登录后通过 authStateChanged 推送结果
  rpc.send("startLogin", {});
}

export async function logout() {
  await rpc.request("logout", {});
  applyAuthState({ loggedIn: false });
}
