import { api } from "./api";
import { storeAccessToken } from "./auth";
import { enterWorkspace } from "./workspace-store.svelte";
import {
  createWorkspaceCreator,
  type CreateResponse,
  type CreateResult,
  type CreateWorkspaceInput,
} from "./create-workspace";

/**
 * 把纯逻辑层 `createWorkspaceCreator` 绑定到模块级单例：
 * api client / OIDC refresh / 响应式 workspace store / URL。
 * 逻辑与编排在 `create-workspace.ts`（单测覆盖），这里只接线。
 */
function browserNavigate(url: string): void {
  if (typeof window !== "undefined") window.history.pushState({}, "", url);
}

/** 后端错误体 `{ error: { code, message, details? } }`；details 可能带 { slug, dbName }。 */
type ApiErrorBody = {
  error?: { code?: string; message?: string; details?: unknown };
};

const creator = createWorkspaceCreator({
  requestCreate: async (input): Promise<CreateResponse> => {
    const res = await api.api.workspaces.$post({ json: input });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
      const err = new Error(body?.error?.code ?? `workspace-create failed: ${res.status}`) as Error & {
        status: number;
        details?: unknown;
      };
      err.status = res.status;
      err.details = body?.error?.details;
      throw err;
    }
    return (await res.json()) as CreateResponse;
  },
  storeAccessToken,
  enterWorkspace,
  navigate: browserNavigate,
});

export function createWorkspace(input: CreateWorkspaceInput): Promise<CreateResult> {
  return creator.createWorkspace(input);
}
