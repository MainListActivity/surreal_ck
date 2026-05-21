import type { SyncDb } from "../sync/types";
import { syncErrorMessage } from "../sync/operation-error";

type RemoteConnectionState = SyncDb & {
  isConnected?: boolean;
  status?: string;
};

export function isRemoteConnectionReady(remote: SyncDb | null): remote is SyncDb {
  if (!remote) return false;

  const state = remote as RemoteConnectionState;
  if (typeof state.isConnected === "boolean") return state.isConnected;
  if (typeof state.status === "string") return state.status === "connected";

  // Unit-test fakes and non-websocket SyncDb implementations do not expose SDK state.
  return true;
}

export function isConnectionUnavailableError(err: unknown): boolean {
  const message = syncErrorMessage(err);
  return /must be connected to a SurrealDB instance|connection unavailable|not connected|disconnected/i.test(message);
}
