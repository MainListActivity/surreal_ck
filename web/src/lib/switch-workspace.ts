import type { EnterWorkspaceInput } from "./workspace-store";

/**
 * Workspace 列表项；权威来自后端 Workspace Scope Module
 * （`GET /api/session/workspaces`），不来自 IdP token。
 */
export type WorkspaceListItem = {
  slug: string;
  name: string;
  dbName: string;
  role: "admin" | "participant";
  lastSelectedAt: string | null;
};

export type LoadWorkspacesResult = {
  workspaces: WorkspaceListItem[];
  /** token scope 中 `https://surrealdb.com/db` 对应的当前 db；用于高亮当前项。 */
  currentDbName: string | null;
  /** 是否显示「新建 workspace」按钮，由 token claim 决定。 */
  canCreate: boolean;
};

export type SwitchResult =
  | { ok: true; noop?: boolean }
  | { ok: false; reason: "forbidden" | "refresh-failed" | "error"; message?: string };

/** 后端 `POST /api/session/switch-workspace` 的正常返回。 */
export type SwitchResponse = { ok: boolean; refreshRequired: boolean };

/**
 * switch-workspace 的全部外部依赖；注入以便单测，默认绑定到模块级单例。
 */
export type SwitchDeps = {
  listWorkspaces(): Promise<WorkspaceListItem[]>;
  requestSwitch(workspaceSlug: string): Promise<SwitchResponse>;
  refresh(): Promise<string | null>;
  enterWorkspace(input: EnterWorkspaceInput): Promise<void>;
  getToken(): string | null;
  navigate(url: string): void;
};

export type WorkspaceSwitcher = {
  loadWorkspaces(): Promise<LoadWorkspacesResult>;
  switchWorkspace(slug: string): Promise<SwitchResult>;
};

const SURREAL_DB_CLAIM = "https://surrealdb.com/db";
const NS_CREATE_CLAIM = "https://surreal-ck.com/can_create_workspace";

function decodeBase64UrlJson(value: string): unknown {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = globalThis.atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function decodeJwtPayload(token: string | null): Record<string, unknown> | null {
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const decoded = decodeBase64UrlJson(payload);
    return decoded && typeof decoded === "object" ? (decoded as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 当前 token scope 指向的 workspace db（与列表项 `dbName` 比对得当前项）。 */
export function currentDbFromToken(token: string | null): string | null {
  const claim = decodeJwtPayload(token)?.[SURREAL_DB_CLAIM];
  return typeof claim === "string" ? claim : null;
}

/** 与后端 `routes/workspaces.ts:canCreateWorkspace` 保持同一判定口径。 */
export function canCreateWorkspace(token: string | null): boolean {
  const raw = decodeJwtPayload(token);
  if (!raw) return false;
  if (raw.can_create_workspace === true) return true;
  if (raw[NS_CREATE_CLAIM] === true) return true;
  const scope = raw.scope;
  return typeof scope === "string" && scope.split(/\s+/).includes("workspace:create");
}

function errorStatus(error: unknown): number | null {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return null;
}

export function createWorkspaceSwitcher(deps: SwitchDeps): WorkspaceSwitcher {
  return {
    async loadWorkspaces() {
      const token = deps.getToken();
      const workspaces = await deps.listWorkspaces();
      return {
        workspaces,
        currentDbName: currentDbFromToken(token),
        canCreate: canCreateWorkspace(token),
      };
    },

    async switchWorkspace(slug) {
      const workspaces = await deps.listWorkspaces();
      const target = workspaces.find((ws) => ws.slug === slug);
      // 不在权威列表里 = 无权访问，直接拒绝，不打后端。
      if (!target) return { ok: false, reason: "forbidden" };

      // 已经在目标 workspace：短路，避免无谓的 switch / refresh / 重连。
      if (currentDbFromToken(deps.getToken()) === target.dbName) {
        return { ok: true, noop: true };
      }

      try {
        await deps.requestSwitch(slug);
      } catch (error) {
        if (errorStatus(error) === 403) return { ok: false, reason: "forbidden" };
        return {
          ok: false,
          reason: "error",
          message: error instanceof Error ? error.message : String(error),
        };
      }

      // 后端已更新 IdP token scope；silent refresh 拿到带新 db scope 的 token。
      const newToken = await deps.refresh();
      if (!newToken) return { ok: false, reason: "refresh-failed" };

      // 用新 token 连新库，旧连接由 enterWorkspace → connectSurreal 关闭。
      await deps.enterWorkspace({
        rawToken: newToken,
        dbName: target.dbName,
        role: target.role,
        slug: target.slug,
        name: target.name,
      });

      deps.navigate(`/w/${target.slug}`);
      return { ok: true };
    },
  };
}
