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
    expect(SYNC_SCOPE.some((entry) => LOCAL_ONLY_TABLES.some((table) => table === entry.table))).toBe(false);
  });

  test("共享资源库同步范围符合 ADR 的 remote/local 边界", () => {
    expect(getScope("resource_item")).toBe("remote");
    expect(getScope("resource_embedding")).toBe("remote");
    expect(getScope("workspace_embedding_profile")).toBe("remote");

    expect(isInSyncScope("research_session")).toBe(false);
    expect(isInSyncScope("local_resource_session_link")).toBe(false);
  });
});

function getScope(table: string): string | null {
  return SYNC_SCOPE.find((entry) => entry.table === table)?.scope ?? null;
}
