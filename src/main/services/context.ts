import { RecordId, StringRecordId } from "surrealdb";
import { getLocalDb, getRemoteDb } from "../db/index";
import { getSession } from "../auth/session";
import { ServiceError } from "./errors";
import type { RecordIdString, WorkspaceDTO } from "../../shared/rpc.types";

export type ServiceContext = {
  isAuthenticated: boolean;
  isOffline: boolean;
  readOnly: boolean;
  userId?: RecordIdString;
  defaultWorkspace?: WorkspaceDTO;
};

let _offlineMode = false;

export function setOfflineMode(offline: boolean): void {
  _offlineMode = offline;
}

export function getOfflineMode(): boolean {
  return _offlineMode;
}

/** 返回当前服务上下文；不会抛出，调用方根据 isAuthenticated 决定是否继续。 */
export function getServiceContext(): ServiceContext {
  const session = getSession();
  const isAuthenticated = session !== null;
  const isOffline = _offlineMode;
  const readOnly = isOffline;

  if (!isAuthenticated) {
    return { isAuthenticated: false, isOffline, readOnly: true };
  }

  return { isAuthenticated: true, isOffline, readOnly };
}

/** 断言当前用户已认证，否则抛出 ServiceError。 */
export function assertAuthenticated(): void {
  const session = getSession();
  if (session === null) {
    throw new ServiceError("NOT_AUTHENTICATED");
  }
}

/** 断言当前处于可写状态，否则抛出 ServiceError。 */
export function assertWritable(): void {
  assertAuthenticated();
  if (_offlineMode) {
    throw new ServiceError("OFFLINE_READ_ONLY");
  }
}

type CurrentUserRow = { id: RecordId };
type WorkspaceAccessRow = { id: RecordId };

async function getCurrentUserId(): Promise<RecordId> {
  assertAuthenticated();

  const db = getLocalDb();
  const rows = await db.query<[CurrentUserRow[]]>(
    `SELECT id FROM app_user LIMIT 1`
  );
  const user = rows[0]?.[0];
  if (!user) throw new ServiceError("BOOTSTRAP_REQUIRED");
  return user.id;
}

/** 断言用户有指定 workspace 的读权限。 */
export async function assertCanReadWorkspace(workspaceId: string): Promise<void> {
  const userId = await getCurrentUserId();
  const db = getLocalDb();
  const rows = await db.query<[WorkspaceAccessRow[]]>(
    `SELECT id
     FROM workspace
     WHERE id = $workspaceId
       AND (owner = $userId OR id IN $userId<-has_workspace_member<-workspace)
     LIMIT 1`,
    { workspaceId: new StringRecordId(workspaceId), userId }
  );

  if (!rows[0]?.[0]) {
    throw new ServiceError("NOT_FOUND", "工作区不存在或无权访问");
  }
}

/** 断言用户有指定 workspace 的写权限。 */
export async function assertCanWriteWorkspace(workspaceId: string): Promise<void> {
  assertWritable();
  await assertCanReadWorkspace(workspaceId);
}
