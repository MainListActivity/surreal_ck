import { describe, expect, test } from "bun:test";
import {
  getSyncRuntimeState,
  markDirtyProjectionData,
  markDirtyStructureShadow,
  markIncompatibleSchema,
  resetSyncRuntimeStateForTests,
} from "./status";

describe("同步运行状态", () => {
  test("可以标记 schema 不兼容、结构影子库 dirty 和投影数据区 dirty", () => {
    resetSyncRuntimeStateForTests();

    markIncompatibleSchema(true);
    markDirtyStructureShadow(true);
    markDirtyProjectionData(true);

    expect(getSyncRuntimeState()).toMatchObject({
      incompatibleSchema: true,
      dirtyStructureShadow: true,
      dirtyProjectionData: true,
    });
  });
});
