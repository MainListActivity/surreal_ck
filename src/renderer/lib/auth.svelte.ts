import type { AuthState } from "../../shared/rpc.types";

export const auth = $state<AuthState>({ loggedIn: false });

export function applyAuthState(state: AuthState) {
  auth.loggedIn = state.loggedIn;
  auth.expiresAt = state.expiresAt;
  auth.error = state.error;
}
