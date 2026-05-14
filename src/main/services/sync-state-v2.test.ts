import { beforeEach, describe, expect, test } from "bun:test";
import {
  markDirtyStructureShadow,
  markDirtyProjectionData,
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
    expect(status.dirtyProjectionData).toBe(false);
    expect(status.incompatibleSchema).toBe(false);
    expect(status.lastRebuildAt).toBeUndefined();
    expect(status.lastError).toBeUndefined();
  });

  test("反映结构影子库 dirty / 投影数据区 dirty / rebuildInProgress / lastRebuildAt / lastError", () => {
    markDirtyStructureShadow(true);
    markDirtyProjectionData(true);
    markRebuildInProgress(true);
    markLastRebuildAt("2026-05-13T10:00:00.000Z");
    setSyncLastError("boom");

    const status = getSyncStatusV2({ isOnline: () => false });
    expect(status).toEqual({
      online: false,
      rebuildInProgress: true,
      dirtyStructureShadow: true,
      dirtyProjectionData: true,
      incompatibleSchema: false,
      lastRebuildAt: "2026-05-13T10:00:00.000Z",
      lastError: "boom",
    });
  });
});
