import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SyncDb, SyncQuery } from "../sync/types";

let mockSession: { expiresAt: number } | null = null;

function normalizeQuery(sql: SyncQuery, bindings?: Record<string, unknown>) {
  if (typeof sql === "string") return { sql, bindings };
  return { sql: sql.query, bindings: sql.bindings };
}

class FakeDb implements SyncDb {
  queries: Array<{ sql: string; bindings?: Record<string, unknown> }> = [];

  constructor(public workbookRows: Array<Record<string, unknown>> = []) {}

  async query<T = unknown>(query: SyncQuery, bindings?: Record<string, unknown>): Promise<T> {
    const normalized = normalizeQuery(query, bindings);
    this.queries.push(normalized);

    if (normalized.sql.includes("FROM app_user")) {
      return [[{ id: "app_user:u1" }]] as T;
    }

    if (normalized.sql.includes("FROM workspace")) {
      return [[{ id: "workspace:ws1" }]] as T;
    }

    if (normalized.sql.includes("FROM workbook")) {
      return [this.workbookRows] as T;
    }

    return [[]] as T;
  }
}

let localDb = new FakeDb();
let remoteDb = new FakeDb();

mock.module("../db/index", () => ({
  getLocalDb: () => localDb,
  getRemoteDb: () => remoteDb,
}));

mock.module("../auth/session", () => ({
  getSession: () => mockSession,
  getPublicAuthState: () =>
    mockSession ? { loggedIn: true, expiresAt: mockSession.expiresAt } : { loggedIn: false },
}));

import { listWorkbooks } from "./workbooks";

describe("工作簿读路径", () => {
  beforeEach(() => {
    mockSession = { expiresAt: Date.now() + 3600_000 };
    localDb = new FakeDb();
    remoteDb = new FakeDb();
  });

  test("结构影子重建后 listWorkbooks 仍只查询本地 workbook 表", async () => {
    localDb.workbookRows = [
      {
        id: "workbook:wb1",
        workspace: "workspace:ws1",
        name: "债权台账",
        template_key: "claims",
        updated_at: new Date("2026-05-13T00:00:00.000Z"),
      },
    ];

    const result = await listWorkbooks({ workspaceId: "workspace:ws1" });

    expect(result.workbooks).toEqual([
      {
        id: "workbook:wb1",
        workspaceId: "workspace:ws1",
        name: "债权台账",
        templateKey: "claims",
        folderId: undefined,
        updatedAt: "2026-05-13T00:00:00.000Z",
      },
    ]);
    expect(localDb.queries.some((query) => query.sql.includes("FROM workbook"))).toBe(true);
    expect(remoteDb.queries).toHaveLength(0);
  });
});
