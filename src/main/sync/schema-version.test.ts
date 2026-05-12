import { describe, expect, test } from "bun:test";
import { checkRemoteSchemaVersion } from "./schema-version";
import type { SyncDb, SyncQuery } from "./types";

class FakeDb implements SyncDb {
  async query<T = unknown>(sql: SyncQuery): Promise<T> {
    if (typeof sql === "string" && sql.includes("schema_version:current")) {
      throw Object.assign(
        new Error("IAM error: Not enough permissions to perform this action"),
        { kind: "NotAllowed", code: 0 },
      );
    }
    return [[]] as T;
  }
}

describe("远端 schema version 检查", () => {
  test("权限错误包含具体查询", async () => {
    await expect(checkRemoteSchemaVersion(new FakeDb())).rejects.toThrow(
      `remote schema version check query="SELECT version FROM schema_version:current LIMIT 1": IAM error: Not enough permissions to perform this action`,
    );
  });
});
