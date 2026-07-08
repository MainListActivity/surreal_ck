import { api as defaultApi } from "./api";

export type WorkspaceMetaWriteResult =
  | { ok: true; name: string }
  | { ok: false; message: string };

export type WorkspaceMetaEndpointResponse = {
  ok: boolean;
  status?: number;
  json(): Promise<unknown>;
};

export type WorkspaceMetaEndpointClient = {
  rename(slug: string, name: string): Promise<WorkspaceMetaEndpointResponse>;
};

type HonoWorkspaceMetaRouteClient = {
  api: {
    workspaces: {
      ":slug": {
        $patch(input: { param: { slug: string }; json: { name: string } }): Promise<WorkspaceMetaEndpointResponse>;
      };
    };
  };
};

export const honoWorkspaceMetaEndpoint: WorkspaceMetaEndpointClient = {
  async rename(slug, name) {
    const client = defaultApi as unknown as HonoWorkspaceMetaRouteClient;
    return client.api.workspaces[":slug"].$patch({ param: { slug }, json: { name } });
  },
};

function responseMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message) return message;
    }
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}

export async function renameWorkspace(
  slug: string,
  name: string,
  endpoint: WorkspaceMetaEndpointClient = honoWorkspaceMetaEndpoint,
): Promise<WorkspaceMetaWriteResult> {
  const trimmedName = name.trim();
  if (!trimmedName) return { ok: false, message: "工作区名称不能为空" };

  try {
    const response = await endpoint.rename(slug, trimmedName);
    if (response.ok) return { ok: true, name: trimmedName };
    const body = await response.json().catch(() => null);
    return {
      ok: false,
      message: responseMessage(body, `请求失败${response.status ? ` (${response.status})` : ""}`),
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
