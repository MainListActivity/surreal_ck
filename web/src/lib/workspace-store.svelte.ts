import { parseUserFromToken } from "./auth";
import { connectSurreal } from "./surreal";
import {
  createWorkspaceState,
  type ConnectionState,
  type CurrentUser,
  type CurrentWorkspace,
  type EnterWorkspaceInput,
} from "./workspace-store";

/**
 * Reactive mirror of the workspace logic layer. The plain `createWorkspaceState`
 * holds the real logic (and is unit-tested); this file only republishes its
 * snapshots into Svelte 5 runes so components update.
 */
const reactive = $state<{
  currentUser: CurrentUser | null;
  currentWorkspace: CurrentWorkspace | null;
  connectionState: ConnectionState;
}>({
  currentUser: null,
  currentWorkspace: null,
  connectionState: "closed",
});

const state = createWorkspaceState({
  surrealUrl: import.meta.env.VITE_SURREAL_URL,
  namespace: "main",
  connect: connectSurreal,
  onChange(snapshot) {
    reactive.currentUser = snapshot.currentUser;
    reactive.currentWorkspace = snapshot.currentWorkspace;
    reactive.connectionState = snapshot.connectionState;
  },
});

export function enterWorkspace(input: EnterWorkspaceInput): Promise<void> {
  // 调用方（switch / create / bootstrap）只传 rawToken，不带 user；在此从 token
  // 解析身份 claim 初始化 currentUser，侧栏头像才能显示真实昵称而非占位「我」。
  // per-workspace 的 display_name 随后由个人中心保存覆盖。
  const user = input.user ?? parseUserFromToken(input.rawToken) ?? undefined;
  return state.enterWorkspace({ ...input, user });
}

export function setCurrentUserDisplayName(displayName: string | null): void {
  state.setCurrentUserDisplayName(displayName);
}

export function setCurrentWorkspaceName(name: string): void {
  state.setCurrentWorkspaceName(name);
}

export function getCurrentUser(): CurrentUser | null {
  return reactive.currentUser;
}

export function getCurrentWorkspace(): CurrentWorkspace | null {
  return reactive.currentWorkspace;
}

export function getConnectionState(): ConnectionState {
  return reactive.connectionState;
}
