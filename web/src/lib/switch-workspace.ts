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

/** 后端 `GET /api/session/workspaces` 的返回：列表 + 是否可建库。 */
export type ListWorkspacesResponse = {
  workspaces: WorkspaceListItem[];
  /** `_system.system_admin` 表非空时为 true；是否可建库由后端判定。 */
  canCreate: boolean;
};

export type LoadWorkspacesResult = {
  workspaces: WorkspaceListItem[];
  /** token scope 中 `https://surrealdb.com/db` 对应的当前 db；用于高亮当前项。 */
  currentDbName: string | null;
  /** 是否显示「新建 workspace」按钮，权威来自后端 `canCreate`。 */
  canCreate: boolean;
};

export type SwitchResult =
  | { ok: true; noop?: boolean }
  | { ok: false; reason: "forbidden" | "refresh-failed" | "error"; message?: string };

/** 页面加载/刷新后建立直连的结果；ok 时带最终进入的 slug。 */
export type BootstrapResult =
  | { ok: true; slug: string }
  // 没有任何可用 workspace；canCreate 决定是引导创建还是提示联系管理员邀请。
  | { ok: false; reason: "none"; canCreate: boolean }
  | { ok: false; reason: "forbidden" | "refresh-failed" | "error"; message?: string };

/** 后端 `POST /api/session/switch-workspace` 的正常返回。 */
export type SwitchResponse = { ok: boolean; refreshRequired: boolean };

/**
 * switch-workspace 的全部外部依赖；注入以便单测，默认绑定到模块级单例。
 */
export type SwitchDeps = {
  listWorkspaces(): Promise<ListWorkspacesResponse>;
  requestSwitch(workspaceSlug: string): Promise<SwitchResponse>;
  refresh(): Promise<string | null>;
  enterWorkspace(input: EnterWorkspaceInput): Promise<void>;
  getToken(): string | null;
  navigate(url: string): void;
};

export type WorkspaceSwitcher = {
  loadWorkspaces(): Promise<LoadWorkspacesResult>;
  switchWorkspace(slug: string): Promise<SwitchResult>;
  /**
   * 页面加载/刷新后，按 URL slug（或 token 当前 db / 首个 workspace）建立 SurrealDB 直连。
   * switchWorkspace 在「已在目标」时短路不连库，故进入页面必须走这里把连接拉起来。
   */
  bootstrapWorkspace(slug?: string): Promise<BootstrapResult>;
};

const SURREAL_DB_CLAIM = "https://surrealdb.com/db";

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

function errorStatus(error: unknown): number | null {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return null;
}

export function createWorkspaceSwitcher(deps: SwitchDeps): WorkspaceSwitcher {
  const switcher: WorkspaceSwitcher = {
    async loadWorkspaces() {
      const { workspaces, canCreate } = await deps.listWorkspaces();
      return {
        workspaces,
        currentDbName: currentDbFromToken(deps.getToken()),
        canCreate,
      };
    },

    async switchWorkspace(slug) {
      const { workspaces } = await deps.listWorkspaces();
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

    async bootstrapWorkspace(slug) {
      const { workspaces, canCreate } = await deps.listWorkspaces();
      // 空列表：不是错误，可能是新账号。canCreate 权威来自后端 Workspace Scope Module，
      // 让 UI 决定是引导创建还是提示联系管理员邀请。
      if (workspaces.length === 0) {
        return { ok: false, reason: "none", canCreate };
      }

      const currentDb = currentDbFromToken(deps.getToken());

      // 目标优先级：URL slug → token 当前 db 对应 → 首个 workspace。
      let target: WorkspaceListItem | undefined;
      if (slug) {
        target = workspaces.find((ws) => ws.slug === slug);
        if (!target) return { ok: false, reason: "forbidden" };
      } else {
        target =
          (currentDb ? workspaces.find((ws) => ws.dbName === currentDb) : undefined) ??
          workspaces[0];
      }

      // token 已 scope 到目标 db：直接用现有 token 连库（switchWorkspace 此时会短路不连）。
      if (currentDb === target.dbName) {
        await deps.enterWorkspace({
          rawToken: deps.getToken() ?? "",
          dbName: target.dbName,
          role: target.role,
          slug: target.slug,
          name: target.name,
        });
        return { ok: true, slug: target.slug };
      }

      // 否则走完整 switch（POST switch → refresh → enter）。
      const result = await switcher.switchWorkspace(target.slug);
      if (result.ok) return { ok: true, slug: target.slug };
      return { ok: false, reason: result.reason, message: result.message };
    },
  };

  return switcher;
}
