import { getLocalDb, getRemoteDb } from "../db/index";
import { rebuildEntProjections } from "../sync/ent-projection";
import { rebuildRelProjections } from "../sync/rel-projection";
import { recoverDirtyStructureShadow } from "../sync/structure-live";
import { rebuildFixedSharedStructureShadow } from "../sync/structure-shadow";
import {
  getSyncRuntimeState,
  markDirtyProjectionData,
  markDirtyStructureShadow,
  markLastRebuildAt,
  markRebuildInProgress,
} from "../sync/status";
import { getOfflineMode } from "./offline-state";
import { getNeedsRelogin, getReconnecting } from "./reconnect";
import { getNextRetryAt } from "./reconnect-scheduler";
import type { SyncStatusV2DTO } from "../../shared/rpc.types";

export type GetSyncStatusV2Options = {
  isOnline?: () => boolean;
};

export function getSyncStatusV2(options: GetSyncStatusV2Options = {}): SyncStatusV2DTO {
  const runtime = getSyncRuntimeState();
  const isOnline = options.isOnline
    ? options.isOnline()
    : !getOfflineMode() && getRemoteDb() !== null && !runtime.incompatibleSchema;
  const needsRelogin = getNeedsRelogin();
  const reconnecting = getReconnecting();
  const nextRetryAt = getNextRetryAt();

  return {
    online: isOnline,
    rebuildInProgress: runtime.rebuildInProgress,
    dirtyStructureShadow: runtime.dirtyStructureShadow,
    dirtyProjectionData: runtime.dirtyProjectionData,
    incompatibleSchema: runtime.incompatibleSchema,
    ...(runtime.lastRebuildAt ? { lastRebuildAt: runtime.lastRebuildAt } : {}),
    ...(runtime.lastError ? { lastError: runtime.lastError } : {}),
    ...(needsRelogin ? { needsRelogin: true } : {}),
    ...(reconnecting ? { reconnecting: true } : {}),
    ...(nextRetryAt !== null ? { nextRetryAt } : {}),
  };
}

export async function triggerSyncRebuild(): Promise<SyncStatusV2DTO> {
  const remote = getRemoteDb();
  if (!remote) throw new Error("[sync] remote db is not connected");
  const local = getLocalDb();
  markRebuildInProgress(true);
  try {
    await rebuildFixedSharedStructureShadow({ localDb: local, remoteDb: remote });
    await rebuildEntProjections({ localDb: local, remoteDb: remote });
    await rebuildRelProjections({ localDb: local, remoteDb: remote });
    markDirtyStructureShadow(false);
    markDirtyProjectionData(false);
    markLastRebuildAt(new Date().toISOString());
  } finally {
    markRebuildInProgress(false);
  }
  // 上面成功完成后，再尝试 recover dirty（若仍存在）
  await recoverDirtyStructureShadow({ localDb: local, remoteDb: remote });
  return getSyncStatusV2();
}
