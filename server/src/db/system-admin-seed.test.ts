import { describe, expect, test } from "bun:test";
import { seedSystemAdmins, type SystemAdminSeedClient } from "./system-admin-seed";

class FakeDb implements SystemAdminSeedClient {
  readonly queries: Array<{ sql: string; params?: Record<string, unknown> }> = [];
  readonly useCalls: Array<{ namespace: string; database: string }> = [];

  async use(scope: { namespace: string; database: string }): Promise<void> {
    this.useCalls.push(scope);
  }

  async query(sql: string, params?: Record<string, unknown>): Promise<unknown> {
    this.queries.push({ sql, params });
    return [[]];
  }
}

describe("seedSystemAdmins", () => {
  test("upserts each subject from the CSV into _system.system_admin", async () => {
    const db = new FakeDb();

    const result = await seedSystemAdmins(db, {
      subjectsCsv: "user-1, user-2 ,user-3",
      namespace: "main",
    });

    expect(result.seededSubjects).toEqual(["user-1", "user-2", "user-3"]);
    expect(db.useCalls.at(-1)).toEqual({ namespace: "main", database: "_system" });

    const upserts = db.queries.filter((q) => q.sql.includes("INTO system_admin"));
    expect(upserts).toHaveLength(3);
    expect(upserts.every((q) => q.sql.includes("ON DUPLICATE KEY UPDATE"))).toBe(true);
    expect(upserts.map((q) => q.params?.subject)).toEqual(["user-1", "user-2", "user-3"]);
  });

  test("dedupes repeated subjects", async () => {
    const db = new FakeDb();

    const result = await seedSystemAdmins(db, {
      subjectsCsv: "user-1,user-1,user-2",
      namespace: "main",
    });

    expect(result.seededSubjects).toEqual(["user-1", "user-2"]);
    expect(db.queries.filter((q) => q.sql.includes("INTO system_admin"))).toHaveLength(2);
  });

  test("no-ops when the CSV is empty or undefined (no use, no writes)", async () => {
    const db = new FakeDb();

    const result = await seedSystemAdmins(db, { subjectsCsv: "  ,  ", namespace: "main" });

    expect(result.seededSubjects).toEqual([]);
    expect(db.useCalls).toHaveLength(0);
    expect(db.queries).toHaveLength(0);
  });
});
