import { describe, expect, test } from "bun:test";
import {
  formatRelativeTime,
  countWorkbooks,
  buildTrendBuckets,
  loadDailyActivityTrend,
  type DailyCountRow,
} from "./activity-panel";
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

describe("buildTrendBuckets — 7 天补零趋势", () => {
  // 2026-06-26 是周五。
  const now = new Date(2026, 5, 26, 12, 0, 0);

  test("返回连续 7 个桶（最旧→最新，含今天），缺失日期补 0", () => {
    const rows: DailyCountRow[] = [
      { day: "2026-06-26", value: 5 },
      { day: "2026-06-24", value: 2 },
    ];
    const bars = buildTrendBuckets(rows, 7, now);
    expect(bars).toHaveLength(7);
    // 末桶是今天
    expect(bars[6]).toEqual({ label: "周五", value: 5 });
    // 06-24 是周三
    expect(bars[4]).toEqual({ label: "周三", value: 2 });
    // 其余补 0
    expect(bars[5]).toEqual({ label: "周四", value: 0 });
    expect(bars[0].value).toBe(0);
  });

  test("无数据全 0，label 仍是连续星期", () => {
    const bars = buildTrendBuckets([], 7, now);
    expect(bars.map((b) => b.value)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(bars.map((b) => b.label)).toEqual(["周六", "周日", "周一", "周二", "周三", "周四", "周五"]);
  });

  test("窗口外的日期不计入", () => {
    const rows: DailyCountRow[] = [{ day: "2026-06-01", value: 99 }];
    const bars = buildTrendBuckets(rows, 7, now);
    expect(bars.reduce((s, b) => s + b.value, 0)).toBe(0);
  });
});

describe("loadDailyActivityTrend — 真实趋势查询", () => {
  const now = new Date(2026, 5, 26, 12, 0, 0);

  test("发出按天聚合查询，带 since 绑定，返回补零后的 7 桶", async () => {
    let sql = "";
    let bindings: Record<string, unknown> | undefined;
    const conn = {
      query: async (q: string, b?: Record<string, unknown>) => {
        sql = q;
        bindings = b;
        return [{ day: "2026-06-26", value: 3 }] as DailyCountRow[];
      },
    } as unknown as Pick<SurrealConn, "query">;

    const bars = await loadDailyActivityTrend(conn, 7, now);

    expect(sql).toContain("FROM activity_event");
    expect(sql).toContain('time::format(created_at, "%Y-%m-%d")');
    expect(sql).toContain("GROUP BY day");
    expect(sql).not.toMatch(/WHERE .*\$auth/);
    // since 绑定为 7 天窗口起点（含今天共 7 天 → 6 天前 0 点）
    expect((bindings?.since as Date).getTime()).toBe(new Date(2026, 5, 20).getTime());
    expect(bars).toHaveLength(7);
    expect(bars[6]).toEqual({ label: "周五", value: 3 });
  });
});
