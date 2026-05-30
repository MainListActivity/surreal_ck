import { api } from "./api";
import { getToken, refresh } from "./auth";
import { enterWorkspace } from "./workspace-store.svelte";
import {
  createWorkspaceSwitcher,
  type BootstrapResult,
  type ListWorkspacesResponse,
  type LoadWorkspacesResult,
  type SwitchResponse,
  type SwitchResult,
} from "./switch-workspace";

/**
 * 把纯逻辑层 `createWorkspaceSwitcher` 绑定到模块级单例：
 * api client / OIDC refresh / 响应式 workspace store / token / URL。
 * 逻辑与编排在 `switch-workspace.ts`（单测覆盖），这里只接线。
 */
function browserNavigate(url: string): void {
  if (typeof window !== "undefined") window.history.pushState({}, "", url);
}

const switcher = createWorkspaceSwitcher({
  listWorkspaces: async () => {
    const res = await api.api.session.workspaces.$get();
    return (await res.json()) as ListWorkspacesResponse;
  },
  requestSwitch: async (workspaceSlug) => {
    const res = await api.api.session["switch-workspace"].$post({
      json: { workspaceSlug },
    });
    if (!res.ok) {
      const err = new Error(`switch-workspace failed: ${res.status}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as SwitchResponse;
  },
  refresh,
  enterWorkspace,
  getToken,
  navigate: browserNavigate,
});

export function loadWorkspaces(): Promise<LoadWorkspacesResult> {
  return switcher.loadWorkspaces();
}

export function switchWorkspace(slug: string): Promise<SwitchResult> {
  return switcher.switchWorkspace(slug);
}

export function bootstrapWorkspace(slug?: string): Promise<BootstrapResult> {
  return switcher.bootstrapWorkspace(slug);
}
