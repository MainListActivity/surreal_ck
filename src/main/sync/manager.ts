import { rebuildFixedSharedStructureShadow } from "./structure-shadow";
import type { SyncDb } from "./types";

export type SyncManagerDeps = {
  localDb: () => SyncDb;
  remoteDb: () => SyncDb | null;
  isOnline: () => boolean;
};

let syncStarted = false;

export async function startSyncWorkers(deps: SyncManagerDeps): Promise<void> {
  if (syncStarted) return;

  const remote = deps.remoteDb();
  if (!remote || !deps.isOnline()) return;

  await rebuildFixedSharedStructureShadow({
    localDb: deps.localDb(),
    remoteDb: remote,
  });
  syncStarted = true;
}

export function stopSyncWorkers(): void {
  syncStarted = false;
}

export function syncWorkersRunningForTests(): boolean {
  return syncStarted;
}
