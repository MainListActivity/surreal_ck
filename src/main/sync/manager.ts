import { LocalToRemoteWorker } from "./local-to-remote-worker";
import { RemoteToLocalWorker } from "./remote-to-local-worker";
import { checkCursorHealthAndRebuild } from "./cursor-health";
import { enumerateSyncTables } from "./tables";
import type { SyncDb } from "./types";

export type SyncManagerDeps = {
  localDb: () => SyncDb;
  remoteDb: () => SyncDb | null;
  isOnline: () => boolean;
};

let localToRemoteWorker: LocalToRemoteWorker | null = null;
let remoteToLocalWorker: RemoteToLocalWorker | null = null;

export async function startSyncWorkers(deps: SyncManagerDeps): Promise<void> {
  if (localToRemoteWorker || remoteToLocalWorker) return;

  const remote = deps.remoteDb();
  if (!remote || !deps.isOnline()) return;

  const tables = await enumerateSyncTables(deps.localDb());
  await checkCursorHealthAndRebuild({ localDb: deps.localDb(), remoteDb: remote, tables });
  const options = {
    localDb: deps.localDb(),
    remoteDb: remote,
    tables,
    isOnline: deps.isOnline,
  };

  localToRemoteWorker = new LocalToRemoteWorker(options);
  remoteToLocalWorker = new RemoteToLocalWorker(options);
  localToRemoteWorker.start();
  remoteToLocalWorker.start();
}

export function stopSyncWorkers(): void {
  localToRemoteWorker?.stop();
  remoteToLocalWorker?.stop();
  localToRemoteWorker = null;
  remoteToLocalWorker = null;
}

export function syncWorkersRunningForTests(): boolean {
  return localToRemoteWorker !== null || remoteToLocalWorker !== null;
}
