import { describe, expect, test } from "bun:test";
import { StringRecordId } from "surrealdb";
import type { SurrealConn } from "./surreal";
import { completeResearchSession } from "./research-data";

function fakeConn(result: unknown) {
  const calls: Array<{ sql: string; bindings?: Record<string, unknown> }> = [];
  const conn = {
    async query(sql: string, bindings?: Record<string, unknown>) {
      calls.push({ sql, bindings });
      return [result];
    },
  } as unknown as SurrealConn;
  return { conn, calls };
}

describe("completeResearchSession", () => {
  test("浏览器直连把会话置为 completed（幂等可重试；RecordId 包裹，PERMISSIONS 由引擎兜底）", async () => {
    const { conn, calls } = fakeConn({ id: "research_session:s1", status: "completed" });

    await completeResearchSession(conn, "research_session:s1");
    // resume 失败后重试：重复完成不报错
    await completeResearchSession(conn, "research_session:s1");

    expect(calls).toHaveLength(2);
    expect(calls[0].sql).toContain("UPDATE ONLY $session");
    expect(calls[0].sql).toContain("status = 'completed'");
    expect(calls[0].bindings?.session).toBeInstanceOf(StringRecordId);
  });

  test("会话不存在 / 无权访问（返回 NONE）→ 抛中文错误", async () => {
    const { conn } = fakeConn(null);

    await expect(completeResearchSession(conn, "research_session:gone")).rejects.toThrow("检索会话");
  });
});
