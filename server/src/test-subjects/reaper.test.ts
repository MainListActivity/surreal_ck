import { describe, expect, test } from "bun:test";
import { runTestSubjectReaper, type TestSubjectReaperDeps } from "./reaper";
import type { Queryable } from "./store";

/** 记录查询并返回预置行的假 _system 会话。 */
function fakeSystemDb(rules: { sql: string; rows?: Record<string, unknown>[] }[]) {
  const deletes: string[] = [];
  const db: Queryable = {
    async query(sql: string, _params: Record<string, unknown> = {}) {
      if (sql.trimStart().startsWith("DELETE")) {
        deletes.push(sql.replace(/\s+/g, " ").slice(0, 80));
        return [[]];
      }
      for (const rule of rules) {
        if (sql.includes(rule.sql)) return [rule.rows ?? []];
      }
      return [[]];
    },
  };
  return { db, deletes };
}

function deps(db: Queryable, dropped: string[], now = "2026-11-10T00:00:00Z"): TestSubjectReaperDeps {
  return {
    systemDb: db,
    dropDatabase: async (name) => { dropped.push(name); },
    now: () => new Date(now),
    log: () => undefined,
  };
}

describe("runTestSubjectReaper", () => {
  test("到期 workspace 被删库并清引用，未到期不动", async () => {
    const { db, deletes } = fakeSystemDb([
      { sql: "test_expires_at != NONE", rows: [
        { id: "workspace:exp", slug: "exp", db_name: "db_exp", owner_subject: "s1", test_origin: "t" },
      ] },
      { sql: "SELECT subject FROM user_workspace_index WHERE workspace", rows: [{ subject: "s1" }] },
      { sql: "SELECT subject FROM test_subject", rows: [{ subject: "s1" }] },
      { sql: "FROM workspace WHERE id", rows: [{ id: "workspace:exp", slug: "exp", db_name: "db_exp", owner_subject: "s1", test_origin: "t" }] },
      { sql: "FROM test_subject WHERE expires_at", rows: [] },
    ]);
    const dropped: string[] = [];
    const result = await runTestSubjectReaper(deps(db, dropped));
    expect(result.workspacesPurged).toBe(1);
    expect(dropped).toEqual(["db_exp"]);
    expect(deletes.some((d) => d.includes("user_workspace_index"))).toBe(true);
    expect(deletes.some((d) => d.includes("quota_policy_projection"))).toBe(true);
    expect(deletes.some((d) => d.includes("DELETE workspace WHERE id"))).toBe(true);
  });

  test("workspace 含非测试成员时跳过且不删库", async () => {
    const { db } = fakeSystemDb([
      { sql: "test_expires_at != NONE", rows: [
        { id: "workspace:mixed", slug: "mixed", db_name: "db_m", owner_subject: "s1", test_origin: null },
      ] },
      { sql: "SELECT subject FROM user_workspace_index WHERE workspace", rows: [{ subject: "s1" }, { subject: "human" }] },
      { sql: "SELECT subject FROM test_subject", rows: [{ subject: "s1" }] },
      { sql: "FROM workspace WHERE id", rows: [{ id: "workspace:mixed", slug: "mixed", db_name: "db_m", owner_subject: "s1", test_origin: null }] },
      { sql: "FROM test_subject WHERE expires_at", rows: [] },
    ]);
    const dropped: string[] = [];
    const result = await runTestSubjectReaper(deps(db, dropped));
    expect(result.workspacesSkipped).toBe(1);
    expect(dropped).toEqual([]);
  });

  test("到期 test_subject 摘除 operator/索引，内容记录不受影响", async () => {
    const { db, deletes } = fakeSystemDb([
      { sql: "test_expires_at != NONE", rows: [] },
      { sql: "FROM test_subject WHERE expires_at", rows: [{ subject: "s_old" }] },
    ]);
    const result = await runTestSubjectReaper(deps(db, []));
    expect(result.subjectsPurged).toBe(1);
    expect(deletes.some((d) => d.includes("platform_operator_capability"))).toBe(true);
    expect(deletes.some((d) => d.includes("DELETE platform_operator"))).toBe(true);
    expect(deletes.some((d) => d.includes("DELETE test_subject"))).toBe(true);
    expect(deletes.some((d) => d.includes("content"))).toBe(false); // 内容不删
  });

  test("注入时钟：未到 expires_at 的 workspace 不进入本轮", async () => {
    const { db } = fakeSystemDb([
      { sql: "test_expires_at != NONE", rows: [] },
      { sql: "FROM test_subject WHERE expires_at", rows: [] },
    ]);
    const result = await runTestSubjectReaper(deps(db, [], "2026-01-01T00:00:00Z"));
    expect(result.workspacesPurged + result.subjectsPurged).toBe(0);
  });
});
