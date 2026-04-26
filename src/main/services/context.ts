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

/** 断言用户有指定 workspace 的读权限（当前阶段：已认证即可读）。 */
export function assertCanReadWorkspace(_workspaceId: string): void {
  assertAuthenticated();
}

/** 断言用户有指定 workspace 的写权限（当前阶段：已认证且可写）。 */
export function assertCanWriteWorkspace(workspaceId: string): void {
  assertWritable();
  assertCanReadWorkspace(workspaceId);
}
