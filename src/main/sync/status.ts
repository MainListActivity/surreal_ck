export type SyncRuntimeState = {
  incompatibleSchema: boolean;
  dirtyStructureShadow: boolean;
  dirtyProjectionData: boolean;
  rebuildInProgress: boolean;
  lastRebuildAt?: string;
  lastError?: string;
};

const state: SyncRuntimeState = {
  incompatibleSchema: false,
  dirtyStructureShadow: false,
  dirtyProjectionData: false,
  rebuildInProgress: false,
};

export function getSyncRuntimeState(): SyncRuntimeState {
  return { ...state };
}

export function markIncompatibleSchema(value: boolean): void {
  state.incompatibleSchema = value;
}

export function markDirtyStructureShadow(value: boolean): void {
  state.dirtyStructureShadow = value;
}

export function markDirtyProjectionData(value: boolean): void {
  state.dirtyProjectionData = value;
}

export function markRebuildInProgress(value: boolean): void {
  state.rebuildInProgress = value;
}

export function markLastRebuildAt(timestamp: string | undefined): void {
  state.lastRebuildAt = timestamp;
}

export function setSyncLastError(message: string | undefined): void {
  state.lastError = message;
}

export function resetSyncRuntimeStateForTests(): void {
  state.incompatibleSchema = false;
  state.dirtyStructureShadow = false;
  state.dirtyProjectionData = false;
  state.rebuildInProgress = false;
  state.lastRebuildAt = undefined;
  state.lastError = undefined;
}
