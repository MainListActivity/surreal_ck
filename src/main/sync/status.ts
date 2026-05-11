export type SyncRuntimeState = {
  incompatibleSchema: boolean;
  localChangefeedStale: boolean;
  lastError?: string;
};

const state: SyncRuntimeState = {
  incompatibleSchema: false,
  localChangefeedStale: false,
};

export function getSyncRuntimeState(): SyncRuntimeState {
  return { ...state };
}

export function markIncompatibleSchema(value: boolean): void {
  state.incompatibleSchema = value;
}

export function markLocalChangefeedStale(value: boolean): void {
  state.localChangefeedStale = value;
}

export function setSyncLastError(message: string | undefined): void {
  state.lastError = message;
}

export function resetSyncRuntimeStateForTests(): void {
  state.incompatibleSchema = false;
  state.localChangefeedStale = false;
  state.lastError = undefined;
}
