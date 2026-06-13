import { describe, expect, test } from "bun:test";
import { formatRelativeTime, countWorkbooks } from "./activity-panel";
import type { SurrealConn } from "./surreal";

describe("formatRelativeTime — 相对时间格式化", () => {
  const now = new Date("2026-06-13T12:00:00");

  test("1分钟内显示 '刚刚'", () => {
    const ts = new Date("2026-06-13T11:59:30");
    expect(formatRelativeTime(ts, now)).toBe("刚刚");
  });

  test("1-59分钟内显示 'N分钟前'", () => {
    const ts = new Date("2026-06-13T11:45:00");
    expect(formatRelativeTime(ts, now)).toBe("15分钟前");
  });

  test("同天超过1小时显示 'N小时前'", () => {
    const ts = new Date("2026-06-13T09:00:00");
    expect(formatRelativeTime(ts, now)).toBe("3小时前");
  });

  test("昨天显示 '昨天'", () => {
    const ts = new Date("2026-06-12T18:00:00");
    expect(formatRelativeTime(ts, now)).toBe("昨天");
  });

  test("7天内显示 'N天前'", () => {
    const ts = new Date("2026-06-10T12:00:00");
    expect(formatRelativeTime(ts, now)).toBe("3天前");
  });

  test("超过7天显示本地日期", () => {
    const ts = new Date("2026-06-01T12:00:00");
    expect(formatRelativeTime(ts, now)).toBe("2026/6/1");
  });
});

describe("countWorkbooks — 查询工作簿总数", () => {
  test("解析 SurrealDB count 响应并返回数字", async () => {
    const fakeConn = {
      query: async (_sql: string) => [{ count: 7 }],
    } as unknown as SurrealConn;

    const count = await countWorkbooks(fakeConn);
    expect(count).toBe(7);
  });

  test("空 workspace 返回 0", async () => {
    const fakeConn = {
      query: async (_sql: string) => [],
    } as unknown as SurrealConn;

    const count = await countWorkbooks(fakeConn);
    expect(count).toBe(0);
  });

  test("发出正确的 SurrealQL", async () => {
    let capturedSql = "";
    const fakeConn = {
      query: async (sql: string) => {
        capturedSql = sql;
        return [{ count: 0 }];
      },
    } as unknown as SurrealConn;

    await countWorkbooks(fakeConn);
    expect(capturedSql).toContain("GROUP ALL");
    expect(capturedSql).toContain("workbook");
  });
});
