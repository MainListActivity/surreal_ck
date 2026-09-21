import type { ISODateTimeString } from "./transport";

// Workspace Scope Module（/api/session/*、/api/workspaces）的 HTTP 契约；
// 权威来自后端 `_system`，不来自 IdP token。

export type WorkspaceRole = "admin" | "participant";

export type WorkspaceListItem = {
  slug: string;
  name: string;
  dbName: string;
  role: WorkspaceRole;
  lastSelectedAt: ISODateTimeString | null;
};

/** `GET /api/session/workspaces` */
export type ListWorkspacesResponse = {
  workspaces: WorkspaceListItem[];
  /** `_system.system_admin` 表非空时为 true；是否可建库由后端判定。 */
  canCreate: boolean;
};

/** `POST /api/session/switch-workspace` 正常返回。 */
export type SwitchWorkspaceResponse = {
  ok: boolean;
  accessToken: string;
  expiresIn: number | null;
};

/** `POST /api/workspaces` 请求体。 */
export type CreateWorkspaceRequest = {
  name: string;
  slug: string;
};

/** `POST /api/workspaces` 正常返回。 */
export type CreateWorkspaceResponse = {
  slug: string;
  dbName: string;
  accessToken: string;
  expiresIn: number | null;
};

/** `POST /api/workspaces/:slug/members` 请求体。 */
export type AddWorkspaceMemberRequest = {
  email: string;
  displayName?: string;
  isAdmin: boolean;
};
