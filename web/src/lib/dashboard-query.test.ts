import { describe, expect, test } from "bun:test";
import type { DashboardBuilderSpec } from "@surreal-ck/shared/rpc.types";
import type { SurrealConn } from "./surreal";
import { runDashboardWidgetQuery } from "./dashboard-query";
import type { DashboardWidget } from "./dashboard-data";

/** 仅实现 dashboard 查询编译器用到的 SurrealConn 窄接口。 */
function fakeConn(over: Partial<SurrealConn> = {}): SurrealConn {
  let conn: SurrealConn;
  conn = {
    status: "connected",
    connect: async () => true,
    use: async () => ({}),
    close: async () => true,
    subscribe: () => () => {},
    query: async () => [],
    queryRaw: async () => [],
    liveTable: async () => () => {},
    updateRecord: async (_id, patch) => patch,
    createRecord: async (_table, data) => data,
    deleteRecord: async () => ({}),
    transaction: async (run) => run(conn),
    ...over,
  } as SurrealConn;
  return conn;
}

describe("runDashboardWidgetQuery — widget 配置直连执行聚合预览", () => {
  test("KPI count 编译成只读参数化 SELECT，并归一化为单值结果", async () => {
    const calls: Array<{ sql: string; bindings: Record<string, unknown> | undefined }> = [];
    const spec: DashboardBuilderSpec = {
      sourceTables: ["ent_claim"],
      baseTable: "ent_claim",
      metric: { op: "count" },
    };
    const conn = fakeConn({
      query: (async (sql: string, bindings?: Record<string, unknown>) => {
        calls.push({ sql, bindings });
        return [{ value: 7 }];
      }) as SurrealConn["query"],
    });

    const preview = await runDashboardWidgetQuery(conn, spec);

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toBe("SELECT count() AS value FROM type::table($tb) GROUP ALL LIMIT 1");
    expect(calls[0].bindings).toEqual({ tb: "ent_claim" });
    expect(preview.result).toEqual({ value: 7, label: "记录数" });
    expect(preview.resultMeta).toEqual({ contract: "single_value", viewType: "kpi" });
    expect(preview.rowsCount).toBe(1);
    expect(preview.sourceTables).toEqual(["ent_claim"]);
    expect(preview.dependencies).toEqual(["ent_claim"]);
  });

  test("KPI sum 使用指标字段聚合，不退回 count", async () => {
    const calls: Array<{ sql: string; bindings: Record<string, unknown> | undefined }> = [];
    const spec: DashboardBuilderSpec = {
      sourceTables: ["ent_claim"],
      baseTable: "ent_claim",
      metric: { op: "sum", field: "amount" },
    };
    const conn = fakeConn({
      query: (async (sql: string, bindings?: Record<string, unknown>) => {
        calls.push({ sql, bindings });
        return [{ value: 320 }];
      }) as SurrealConn["query"],
    });

    const preview = await runDashboardWidgetQuery(conn, spec);

    expect(calls[0].sql).toBe("SELECT math::sum(amount) AS value FROM type::table($tb) GROUP ALL LIMIT 1");
    expect(calls[0].bindings).toEqual({ tb: "ent_claim" });
    expect(preview.result).toEqual({ value: 320, label: "amount 总和" });
  });

  test("KPI count_distinct 编译为子查询去重计数", async () => {
    const calls: Array<{ sql: string; bindings: Record<string, unknown> | undefined }> = [];
    const spec: DashboardBuilderSpec = {
      sourceTables: ["ent_claim"],
      baseTable: "ent_claim",
      metric: { op: "count_distinct", field: "claimant" },
    };
    const conn = fakeConn({
      query: (async (sql: string, bindings?: Record<string, unknown>) => {
        calls.push({ sql, bindings });
        return [{ value: 4 }];
      }) as SurrealConn["query"],
    });

    const preview = await runDashboardWidgetQuery(conn, spec);

    expect(calls[0].sql).toBe(
      "SELECT count() AS value FROM (SELECT claimant FROM type::table($tb) GROUP BY claimant) GROUP ALL LIMIT 1",
    );
    expect(calls[0].bindings).toEqual({ tb: "ent_claim" });
    expect(preview.result).toEqual({ value: 4, label: "claimant 去重数" });
  });

  test("分类维度 + sum 指标编译为 GROUP BY，并归一化为分类结果", async () => {
    const calls: Array<{ sql: string; bindings: Record<string, unknown> | undefined }> = [];
    const spec: DashboardBuilderSpec = {
      sourceTables: ["ent_claim"],
      baseTable: "ent_claim",
      metric: { op: "sum", field: "amount" },
      dimensions: [{ field: "status" }],
      limit: 12,
    };
    const conn = fakeConn({
      query: (async (sql: string, bindings?: Record<string, unknown>) => {
        calls.push({ sql, bindings });
        return [
          { key: "approved", label: "approved", value: "120.5" },
          { key: "pending", label: "pending", value: 80 },
        ];
      }) as SurrealConn["query"],
    });

    const preview = await runDashboardWidgetQuery(conn, spec);

    expect(calls[0].sql).toBe(
      "SELECT status AS key, string::concat(status ?? '') AS label, math::sum(amount) AS value FROM type::table($tb) GROUP BY status ORDER BY value DESC LIMIT 12",
    );
    expect(calls[0].bindings).toEqual({ tb: "ent_claim" });
    expect(preview.resultMeta).toEqual({ contract: "category_breakdown", viewType: "bar" });
    expect(preview.rowsCount).toBe(2);
    expect(preview.result).toEqual({
      rows: [
        { key: "approved", label: "approved", value: 120.5 },
        { key: "pending", label: "pending", value: 80 },
      ],
    });
  });

  test("分类聚合尊重 sort 配置", async () => {
    const calls: Array<{ sql: string; bindings: Record<string, unknown> | undefined }> = [];
    const spec: DashboardBuilderSpec = {
      sourceTables: ["ent_claim"],
      baseTable: "ent_claim",
      metric: { op: "count" },
      dimensions: [{ field: "status" }],
      sort: { field: "status", direction: "asc" },
    };
    const conn = fakeConn({
      query: (async (sql: string, bindings?: Record<string, unknown>) => {
        calls.push({ sql, bindings });
        return [];
      }) as SurrealConn["query"],
    });

    await runDashboardWidgetQuery(conn, spec);

    expect(calls[0].sql).toBe(
      "SELECT status AS key, string::concat(status ?? '') AS label, count() AS value FROM type::table($tb) GROUP BY status ORDER BY status ASC LIMIT 20",
    );
  });

  test("日期维度带 bucket 时编译为时间序列 GROUP BY，并归一化为 x/y 行", async () => {
    const calls: Array<{ sql: string; bindings: Record<string, unknown> | undefined }> = [];
    const spec: DashboardBuilderSpec = {
      sourceTables: ["ent_claim"],
      baseTable: "ent_claim",
      metric: { op: "count" },
      dimensions: [{ field: "created_at", bucket: "day" }],
    };
    const conn = fakeConn({
      query: (async (sql: string, bindings?: Record<string, unknown>) => {
        calls.push({ sql, bindings });
        return [
          { x: "2026-06-01", y: "3" },
          { x: "2026-06-02", y: 5 },
        ];
      }) as SurrealConn["query"],
    });

    const preview = await runDashboardWidgetQuery(conn, spec);

    expect(calls[0].sql).toBe(
      'SELECT time::format(created_at, "%Y-%m-%d") AS x, count() AS y FROM type::table($tb) GROUP BY x ORDER BY x ASC LIMIT 20',
    );
    expect(calls[0].bindings).toEqual({ tb: "ent_claim" });
    expect(preview.resultMeta).toEqual({ contract: "time_series", viewType: "line" });
    expect(preview.result).toEqual({
      rows: [
        { x: "2026-06-01", y: 3 },
        { x: "2026-06-02", y: 5 },
      ],
    });
  });

  test("filters 编译为参数化 WHERE，筛选值不内联进 SQL", async () => {
    const calls: Array<{ sql: string; bindings: Record<string, unknown> | undefined }> = [];
    const spec: DashboardBuilderSpec = {
      sourceTables: ["ent_claim"],
      baseTable: "ent_claim",
      metric: { op: "count" },
      dimensions: [{ field: "status" }],
      filters: [
        { field: "assignee", op: "eq", value: "张三'); DELETE ent_claim;" },
        { field: "amount", op: "gte", value: 100 },
        { field: "status", op: "in", value: ["approved", "pending"] },
        { field: "deleted_at", op: "is_null" },
      ],
    };
    const conn = fakeConn({
      query: (async (sql: string, bindings?: Record<string, unknown>) => {
        calls.push({ sql, bindings });
        return [];
      }) as SurrealConn["query"],
    });

    await runDashboardWidgetQuery(conn, spec);

    expect(calls[0].sql).toBe(
      "SELECT status AS key, string::concat(status ?? '') AS label, count() AS value FROM type::table($tb) WHERE assignee = $f0 AND amount >= $f1 AND status INSIDE $f2 AND deleted_at IS NULL GROUP BY status ORDER BY value DESC LIMIT 20",
    );
    expect(calls[0].sql).not.toContain("DELETE");
    expect(calls[0].bindings).toEqual({
      tb: "ent_claim",
      f0: "张三'); DELETE ent_claim;",
      f1: 100,
      f2: ["approved", "pending"],
    });
  });

  test("非法表名或字段名在执行前被拒绝", async () => {
    let queryCalls = 0;
    const conn = fakeConn({
      query: (async () => {
        queryCalls += 1;
        return [];
      }) as SurrealConn["query"],
    });

    await expect(runDashboardWidgetQuery(conn, {
      sourceTables: ["ent_claim"],
      baseTable: "ent_claim; DELETE ent_claim",
      metric: { op: "count" },
      dimensions: [{ field: "status" }],
    })).rejects.toThrow("非法的数据表名");

    await expect(runDashboardWidgetQuery(conn, {
      sourceTables: ["ent_claim"],
      baseTable: "ent_claim",
      metric: { op: "count" },
      dimensions: [{ field: "status); DELETE ent_claim" }],
    })).rejects.toThrow("非法的分组字段");

    expect(queryCalls).toBe(0);
  });

  test("可直接接收 D3-01 DashboardWidget 包装，并保留 widget.viewType", async () => {
    const widget: DashboardWidget = {
      id: "w1",
      title: "状态占比",
      viewType: "pie",
      spec: {
        sourceTables: ["ent_claim"],
        baseTable: "ent_claim",
        metric: { op: "count" },
        dimensions: [{ field: "status" }],
      },
      grid: { x: 0, y: 0, w: 4, h: 3 },
    };
    const conn = fakeConn({
      query: (async () => [{ key: "approved", label: "approved", value: 2 }]) as SurrealConn["query"],
    });

    const preview = await runDashboardWidgetQuery(conn, widget);

    expect(preview.resultMeta).toEqual({ contract: "category_breakdown", viewType: "pie" });
    expect(preview.result).toEqual({
      rows: [{ key: "approved", label: "approved", value: 2 }],
    });
  });

  test("table widget 按 display.columns 执行结构化列表查询", async () => {
    const calls: Array<{ sql: string; bindings: Record<string, unknown> | undefined }> = [];
    const widget: DashboardWidget = {
      id: "tasks",
      title: "近期待办",
      viewType: "table",
      spec: {
        sourceTables: ["ent_tasks"],
        baseTable: "ent_tasks",
        metric: { op: "count" },
        filters: [{ field: "status", op: "eq", value: "open" }],
        sort: { field: "due_date", direction: "asc" },
        limit: 7,
      },
      grid: { x: 0, y: 0, w: 12, h: 2 },
      display: {
        columns: [
          { key: "title", label: "事项" },
          { key: "due_date", label: "截止日期" },
        ],
      },
    };
    const conn = fakeConn({
      query: (async (sql: string, bindings?: Record<string, unknown>) => {
        calls.push({ sql, bindings });
        return [{ title: "补充材料", due_date: "2026-07-20" }];
      }) as SurrealConn["query"],
    });

    const preview = await runDashboardWidgetQuery(conn, widget);

    expect(calls[0]).toEqual({
      sql: "SELECT title, due_date FROM type::table($tb) WHERE status = $f0 ORDER BY due_date ASC LIMIT 7",
      bindings: { tb: "ent_tasks", f0: "open" },
    });
    expect(preview.resultMeta).toEqual({ contract: "table_rows", viewType: "table" });
    expect(preview.result).toEqual({
      columns: [
        { key: "title", label: "事项" },
        { key: "due_date", label: "截止日期" },
      ],
      rows: [{ title: "补充材料", due_date: "2026-07-20" }],
    });
  });
});
