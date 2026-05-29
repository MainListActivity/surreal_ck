import type { EnterWorkspaceInput } from "./workspace-store";

/** 表单输入：workspace 名称 + slug。 */
export type CreateWorkspaceInput = {
  name: string;
  slug: string;
};

/** 后端 `POST /api/workspaces` 的正常返回。 */
export type CreateResponse = {
  slug: string;
  dbName: string;
  refreshRequired: boolean;
};

export type CreateResult =
  | { ok: true }
  | { ok: false; reason: "slug-conflict" }
  | { ok: false; reason: "scope-update-failed"; slug: string; dbName: string }
  | { ok: false; reason: "forbidden" | "refresh-failed" | "error"; message?: string };

/**
 * createWorkspace 的全部外部依赖；注入以便单测，默认绑定到模块级单例。
 */
export type CreateDeps = {
  requestCreate(input: CreateWorkspaceInput): Promise<CreateResponse>;
  refresh(): Promise<string | null>;
  enterWorkspace(input: EnterWorkspaceInput): Promise<void>;
  navigate(url: string): void;
};

export type WorkspaceCreator = {
  createWorkspace(input: CreateWorkspaceInput): Promise<CreateResult>;
};

function errorStatus(error: unknown): number | null {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return null;
}

/** 从 502 scope-update-failed 错误里取后端回传的 `{ slug, dbName }`。 */
function scopeFailedDetails(error: unknown): { slug: string; dbName: string } | null {
  if (!error || typeof error !== "object" || !("details" in error)) return null;
  const details = (error as { details?: unknown }).details;
  if (
    details &&
    typeof details === "object" &&
    typeof (details as { slug?: unknown }).slug === "string" &&
    typeof (details as { dbName?: unknown }).dbName === "string"
  ) {
    return { slug: (details as { slug: string }).slug, dbName: (details as { dbName: string }).dbName };
  }
  return null;
}

export function createWorkspaceCreator(deps: CreateDeps): WorkspaceCreator {
  return {
    async createWorkspace(input) {
      let created: CreateResponse;
      try {
        created = await deps.requestCreate(input);
      } catch (error) {
        if (errorStatus(error) === 403) return { ok: false, reason: "forbidden" };
        if (errorStatus(error) === 409) return { ok: false, reason: "slug-conflict" };
        if (errorStatus(error) === 502) {
          const details = scopeFailedDetails(error);
          if (details) {
            return { ok: false, reason: "scope-update-failed", slug: details.slug, dbName: details.dbName };
          }
        }
        return {
          ok: false,
          reason: "error",
          message: error instanceof Error ? error.message : String(error),
        };
      }

      // 后端已建库 + 应用模板 + 更新 IdP token scope；silent refresh 拿带新 db scope 的 token。
      const newToken = await deps.refresh();
      if (!newToken) return { ok: false, reason: "refresh-failed" };

      // 创建者是 owner，必然是该 workspace 的 admin。
      await deps.enterWorkspace({
        rawToken: newToken,
        dbName: created.dbName,
        role: "admin",
        slug: created.slug,
        name: input.name,
      });

      deps.navigate(`/w/${created.slug}`);
      return { ok: true };
    },
  };
}
