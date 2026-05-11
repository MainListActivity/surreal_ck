import { describe, expect, test } from "bun:test";
import { getSyncRuntimeState, markIncompatibleSchema, markLocalChangefeedStale, resetSyncRuntimeStateForTests } from "./status";

describe("同步运行状态", () => {
  test("可以标记 schema 不兼容和本地 changefeed 过期", () => {
    resetSyncRuntimeStateForTests();

    markIncompatibleSchema(true);
    markLocalChangefeedStale(true);

    expect(getSyncRuntimeState()).toMatchObject({
      incompatibleSchema: true,
      localChangefeedStale: true,
    });
  });
});
