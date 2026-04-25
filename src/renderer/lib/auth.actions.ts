import { rpc } from "./rpc";
import { applyAuthState } from "./auth.svelte";

export async function login() {
  const state = await rpc.request("startLogin", {});
  applyAuthState(state);
}

export async function logout() {
  await rpc.request("logout", {});
  applyAuthState({ loggedIn: false });
}
