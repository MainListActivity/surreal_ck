import {
  refreshEntProjectionSubscriptions,
  stopEntProjectionSubscriptions,
} from "./ent-projection";
import {
  refreshRelProjectionSubscriptions,
  stopRelProjectionSubscriptions,
} from "./rel-projection";
import {
  markLastRebuildAt,
  markDirtyProjectionData,
  markRebuildInProgress,
} from "./status";
import {
  recoverDirtyStructureShadow,
  startFixedSharedLiveSubscriptions,
  stopFixedSharedLiveSubscriptions,
} from "./structure-live";
import { rebuildFixedSharedStructureShadow } from "./structure-shadow";
import type { LiveSource, SyncDb } from "./types";

export type SyncManagerDeps = {
  localDb: () => SyncDb;
  remoteDb: () => SyncDb | null;
  liveSource?: () => LiveSource | null;
  isOnline: () => boolean;
};

let syncStarted = false;

export async function startSyncWorkers(deps: SyncManagerDeps): Promise<void> {
  if (syncStarted) return;

  const remote = deps.remoteDb();
  if (!remote || !deps.isOnline()) return;

  markRebuildInProgress(true);
  try {
    await rebuildFixedSharedStructureShadow({
      localDb: deps.localDb(),
      remoteDb: remote,
    });
    markLastRebuildAt(new Date().toISOString());
  } finally {
    markRebuildInProgress(false);
  }

  const live = deps.liveSource?.() ?? null;
  if (live) {
    await startFixedSharedLiveSubscriptions({
      localDb: deps.localDb(),
      liveSource: live,
    });
    await refreshEntProjectionSubscriptions({
      localDb: deps.localDb(),
      remoteDb: remote,
      liveSource: live,
    });
    await refreshRelProjectionSubscriptions({
      localDb: deps.localDb(),
      remoteDb: remote,
      liveSource: live,
    });
    markDirtyProjectionData(false);
  }

  await recoverDirtyStructureShadow({
    localDb: deps.localDb(),
    remoteDb: remote,
  });

  syncStarted = true;
}

export async function stopSyncWorkers(): Promise<void> {
  await stopFixedSharedLiveSubscriptions();
  await stopEntProjectionSubscriptions();
  await stopRelProjectionSubscriptions();
  syncStarted = false;
}

export function syncWorkersRunningForTests(): boolean {
  return syncStarted;
}
