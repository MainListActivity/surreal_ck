/**
 * 前端能力判断——**仅用于 UI 禁用态 / 友好提示**，不是安全边界。
 *
 * 真正的权限由 SurrealDB access 类型 + 表 PERMISSIONS 在引擎层硬隔离：admin 走 JWT
 * access 有 DDL，participant/employee 走 RECORD access 只有 DML，越权写入会被引擎直接拒。
 * 这里只是把「按钮该不该灰」这种纯展示判断从 role 字符串派生出来，避免组件里散落
 * `role === "admin"` 字面量。
 *
 * role 取自 token 中签入的 access（见 workspace-store 的 currentWorkspace.role）。
 */
export type WorkspaceRole = "admin" | "participant" | "employee" | (string & {});

/** 是否是工作区管理员（可改表结构 / DDL）。 */
export function isWorkspaceAdmin(role: string | null | undefined): boolean {
  return role === "admin";
}

/** 能否写业务数据（行级 DML）：管理员与普通成员都可以，未登录 / 未签入则不行。 */
export function canWriteEntityData(role: string | null | undefined): boolean {
  return role === "admin" || role === "participant";
}

/** 能否改共享结构（建表 / 改列等 DDL）：仅管理员。 */
export function canWriteSharedStructure(role: string | null | undefined): boolean {
  return isWorkspaceAdmin(role);
}
