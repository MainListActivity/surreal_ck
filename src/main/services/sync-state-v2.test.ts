import { beforeEach, describe, expect, test } from "bun:test";
import {
  markDirtyStructureShadow,
  markLastRebuildAt,
  markRebuildInProgress,
  resetSyncRuntimeStateForTests,
  setSyncLastError,
} from "../sync/status";
import { getSyncStatusV2 } from "./sync-state-v2";

describe("getSyncStatusV2", () => {
  beforeEach(() => {
    resetSyncRuntimeStateForTests();
  });

  test("默认状态：online 由调用方注入；其他都干净", () => {
    const status = getSyncStatusV2({ isOnline: () => true });
    expect(status.online).toBe(true);
    expect(status.rebuildInProgress).toBe(false);
    expect(status.dirtyStructureShadow).toBe(false);
    expect(status.incompatibleSchema).toBe(false);
    expect(status.lastRebuildAt).toBeUndefined();
    expect(status.lastError).toBeUndefined();
  });

  test("反映 dirty / rebuildInProgress / lastRebuildAt / lastError", () => {
    markDirtyStructureShadow(true);
    markRebuildInProgress(true);
    markLastRebuildAt("2026-05-13T10:00:00.000Z");
    setSyncLastError("boom");

    const status = getSyncStatusV2({ isOnline: () => false });
    expect(status).toEqual({
      online: false,
      rebuildInProgress: true,
      dirtyStructureShadow: true,
      incompatibleSchema: false,
      lastRebuildAt: "2026-05-13T10:00:00.000Z",
      lastError: "boom",
    });
  });
});
