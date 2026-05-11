import { describe, expect, test } from "bun:test";
import {
  LOCAL_ONLY_TABLES,
  SYNC_SCOPE,
  isInSyncScope,
  shouldSyncRow,
} from "./scope";

describe("同步范围", () => {
  test("同步表必须显式注册，动态实体和关系表只按约定前缀放行", () => {
    expect(isInSyncScope("workspace")).toBe(true);
    expect(isInSyncScope("ent_contract")).toBe(true);
    expect(isInSyncScope("rel_owns_share")).toBe(true);

    expect(isInSyncScope("sync_cursor")).toBe(false);
    expect(isInSyncScope("token_store")).toBe(false);
    expect(isInSyncScope("wrong_contract")).toBe(false);
    expect(isInSyncScope("new_table")).toBe(false);
  });

  test("app_setting 只同步非敏感行", () => {
    expect(shouldSyncRow("app_setting", { sensitive: false })).toBe(true);
    expect(shouldSyncRow("app_setting", { sensitive: undefined })).toBe(true);
    expect(shouldSyncRow("app_setting", { sensitive: true })).toBe(false);
  });

  test("ADR 中的仅本地表不会进入同步范围", () => {
    for (const table of LOCAL_ONLY_TABLES) {
      expect(isInSyncScope(table)).toBe(false);
    }
    expect(SYNC_SCOPE.some((entry) => entry.table === "sync_cursor")).toBe(false);
    expect(SYNC_SCOPE.some((entry) => entry.table === "sync_dead_letter")).toBe(false);
  });
});
