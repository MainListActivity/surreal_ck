import type { SyncManagerDeps } from "../sync/manager";
import { syncErrorMessage } from "../sync/operation-error";
import type { SyncDb } from "../sync/types";

export type RemoteConnection = SyncDb & {
  connect(url: string): Promise<unknown>;
  use(input: { namespace: string; database: string }): Promise<unknown>;
  authenticate(token: string): Promise<unknown>;
};

export type RemoteConnectionOptions = {
  remoteUrl: string;
  namespace: string;
  database: string;
};

export type RemoteConnectionRuntime<TRemote extends RemoteConnection> = {
  createRemote(): TRemote;
  stopSyncWorkers(): void;
  setRemoteDb(remote: TRemote | null): void;
  getRemoteDb(): SyncDb | null;
  getLocalDb(): SyncDb;
  setOfflineMode(offline: boolean): void;
  setSyncLastError(message: string | undefined): void;
  checkRemoteSchemaVersion(remote: TRemote): Promise<boolean>;
  startSyncWorkers(deps: SyncManagerDeps): Promise<void>;
  log(message: string): void;
  warn(message: string, err?: unknown): void;
};

function isPermissionDenied(err: unknown, message: string): boolean {
  const kind = typeof err === "object" && err !== null && "kind" in err
    ? String((err as { kind: unknown }).kind)
    : "";
  return kind === "NotAllowed" || /IAM error|not enough permissions/i.test(message);
}

export async function connectRemoteWithRuntime<TRemote extends RemoteConnection>(
  accessToken: string,
  options: RemoteConnectionOptions,
  runtime: RemoteConnectionRuntime<TRemote>,
): Promise<void> {
  runtime.stopSyncWorkers();
  runtime.setRemoteDb(null);

  let remote: TRemote;
  try {
    remote = runtime.createRemote();
    await remote.connect(options.remoteUrl);
    await remote.use({
      namespace: options.namespace,
      database: options.database,
    });
    await remote.authenticate(accessToken);
  } catch (err) {
    runtime.warn("[db] remote connection failed (degraded to local-only):", err);
    runtime.setRemoteDb(null);
    runtime.setOfflineMode(true);
    runtime.setSyncLastError(syncErrorMessage(err));
    return;
  }

  runtime.setRemoteDb(remote);
  runtime.setOfflineMode(false);
  runtime.setSyncLastError(undefined);
  runtime.log(`[db] remote connected: ${options.remoteUrl}`);

  try {
    const compatible = await runtime.checkRemoteSchemaVersion(remote);
    if (!compatible) {
      runtime.setSyncLastError("remote schema version is incompatible");
      runtime.warn("[sync] remote schema version is incompatible; sync workers disabled");
      return;
    }

    await runtime.startSyncWorkers({
      localDb: runtime.getLocalDb,
      remoteDb: runtime.getRemoteDb,
      isOnline: () => runtime.getRemoteDb() !== null,
    });
  } catch (err) {
    const message = syncErrorMessage(err);
    runtime.setSyncLastError(message);
    if (isPermissionDenied(err, message)) {
      runtime.warn(`[sync] remote sync disabled: ${message}`);
      return;
    }
    runtime.warn("[sync] remote connected, but sync workers were not started:", err);
  }
}
