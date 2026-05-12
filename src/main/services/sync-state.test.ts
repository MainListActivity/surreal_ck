import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SyncDb } from "../sync/types";

class FakeDb implements SyncDb {
  queries: Array<{ sql: string; bindings?: Record<string, unknown> }> = [];

  async query<T = unknown>(sql: string, bindings?: Record<string, unknown>): Promise<T> {
    this.queries.push({ sql, bindings });

    if (sql.includes("INFO FOR DB")) {
      return [{ tables: { workspace: {}, token_store: {} } }] as T;
    }
    if (sql.includes("SELECT versionstamp")) {
      return [[{ versionstamp: "vs0" }]] as T;
    }
    if (sql.includes("SHOW CHANGES FOR TABLE workspace")) {
      return [[
        { versionstamp: "p1", update: { id: "workspace:a", name: "A" }, dirtyFields: ["name"] },
        { versionstamp: "p2", update: { id: "workspace:b", name: "B" }, dirtyFields: ["name"] },
      ]] as T;
    }
    if (sql.includes("SHOW CHANGES")) {
      return [[]] as T;
    }
    if (sql.includes("SELECT count() AS count FROM sync_cursor WHERE direction = 'local_to_remote'")) {
      return [[{ count: 99 }]] as T;
    }
    if (sql.includes("SELECT count() AS count FROM sync_dead_letter")) {
      return [[{ count: 1 }]] as T;
    }
    if (sql.includes("SELECT updated_at FROM sync_cursor")) {
      return [[{ updated_at: "2026-05-12T00:00:00.000Z" }]] as T;
    }
    return [[]] as T;
  }
}

let localDb = new FakeDb();
let remoteConnected = true;
let offline = false;

mock.module("../db/index", () => ({
  getLocalDb: () => localDb,
  getRemoteDb: () => remoteConnected ? ({}) : null,
}));

mock.module("./offline-state", () => ({
  getOfflineMode: () => offline,
}));

import { resetSyncRuntimeStateForTests } from "../sync/status";
import { resetLocalSessionIdForTests } from "../sync/session";
import { getSyncStatus } from "./sync-state";

describe("同步状态服务", () => {
  beforeEach(() => {
    localDb = new FakeDb();
    remoteConnected = true;
    offline = false;
    resetSyncRuntimeStateForTests();
    resetLocalSessionIdForTests();
  });

  test("pendingCount 来自本地 changefeed 待推送条目，而不是 sync_cursor 行数", async () => {
    const status = await getSyncStatus();

    expect(status.pendingCount).toBe(2);
    expect(status.deadLetterCount).toBe(1);
    expect(localDb.queries.some((query) => query.sql.includes("SHOW CHANGES FOR TABLE workspace"))).toBe(true);
  });
});
