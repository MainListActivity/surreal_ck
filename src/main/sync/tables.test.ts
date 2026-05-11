import { describe, expect, test } from "bun:test";
import { enumerateSyncTables } from "./tables";
import type { SyncDb } from "./types";

describe("同步表枚举", () => {
  test("固定同步表加动态 ent_/rel_，仅本地表不会被枚举", async () => {
    const db: SyncDb = {
      async query<T = unknown>() {
        return [{ tables: {
          ent_contract: {},
          rel_holder: {},
          token_store: {},
          wrong_contract: {},
        } }] as T;
      },
    };

    const tables = await enumerateSyncTables(db);

    expect(tables).toContain("workspace");
    expect(tables).toContain("ent_contract");
    expect(tables).toContain("rel_holder");
    expect(tables).not.toContain("token_store");
    expect(tables).not.toContain("wrong_contract");
  });
});
