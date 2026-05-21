import { beforeEach, describe, expect, mock, test } from "bun:test";
import { RecordId } from "surrealdb";

let mockSession: { expiresAt: number } | null = null;

const sheet = {
  id: new RecordId("sheet", "cases"),
  workbook: new RecordId("workbook", "demo"),
  table_name: "ent_demo_cases",
  column_defs: [
    { key: "title", label: "标题", field_type: "text", required: false },
  ],
};

const fakeDb = {
  queries: [] as string[],
  async query<T>(query: string): Promise<T> {
    this.queries.push(query);
    if (query.includes("FROM sheet")) {
      return [[sheet]] as T;
    }
    if (query.includes("FROM workbook")) {
      return [[{ workspace: new RecordId("workspace", "demo") }]] as T;
    }
    if (query.includes("FROM app_user")) {
      return [[{ id: new RecordId("app_user", "u1") }]] as T;
    }
    if (query.includes("FROM workspace")) {
      return [[{ id: new RecordId("workspace", "demo") }]] as T;
    }
    if (query.includes("INFO FOR DB")) {
      return [{ tables: { ent_demo_cases: {} } }] as T;
    }
    return [] as T;
  },
};

mock.module("../auth/session", () => ({
  getSession: () => mockSession,
  getPublicAuthState: () =>
    mockSession ? { loggedIn: true, expiresAt: mockSession.expiresAt } : { loggedIn: false },
}));

mock.module("../db/index", () => ({
  getLocalDb: () => fakeDb,
}));

describe("editor 写入能力 seam", () => {
  beforeEach(async () => {
    mockSession = { expiresAt: Date.now() + 3600_000 };
    fakeDb.queries = [];
    const { setOfflineMode } = await import("./context");
    setOfflineMode(false);
  });

  test("离线 upsertRows 在能力矩阵拒绝实体表写入", async () => {
    const { setOfflineMode } = await import("./context");
    setOfflineMode(true);
    const { upsertRows } = await import("./editor");

    await expect(upsertRows({ sheetId: "sheet:cases", rows: [] })).rejects.toMatchObject({
      code: "OFFLINE_READ_ONLY",
    });
    expect(fakeDb.queries.some((query) => query.includes("INFO FOR DB"))).toBe(false);
  });
});
