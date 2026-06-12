import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import type { DashboardWidget } from "../../../lib/dashboard-data";
import type { SurrealConn } from "../../../lib/surreal";
import { createDashboardStore, type DashboardStoreSnapshot } from "./dashboard-store";

const kpiWidget: DashboardWidget = {
  id: "w1",
  title: "债权总额",
  viewType: "kpi",
  spec: { sourceTables: ["ent_claim"], baseTable: "ent_claim", metric: { op: "sum", field: "amount" } },
  grid: { x: 0, y: 0, w: 6, h: 1 },
};

const barWidget: DashboardWidget = {
  id: "w2",
  title: "按状态分布",
  viewType: "bar",
  spec: {
    sourceTables: ["ent_claim"],
    baseTable: "ent_claim",
    metric: { op: "count" },
    dimensions: [{ field: "status" }],
  },
  grid: { x: 6, y: 0, w: 6, h: 2 },
};

type QueryCall = { sql: string; bindings?: Record<string, unknown> };

/** 仅实现 store 用到的窄接口；query 按 SQL 形状分发。 */
function fakeConn(
  handlers: { onQuery?: (sql: string, bindings?: Record<string, unknown>) => unknown[] | Promise<unknown[]> } & Partial<SurrealConn> = {},
  calls: QueryCall[] = [],
): SurrealConn {
  let conn: SurrealConn;
  conn = {
    status: "connected",
    connect: async () => true,
    use: async () => ({}),
    close: async () => true,
    subscribe: () => () => {},
    query: (async (sql: string, bindings?: Record<string, unknown>) => {
      calls.push({ sql, bindings });
      return (await handlers.onQuery?.(sql, bindings)) ?? [];
    }) as SurrealConn["query"],
    liveTable: async () => () => {},
    updateRecord: async (_id, patch) => patch,
    createRecord: async (_table, data) => data,
    deleteRecord: async () => ({}),
    transaction: async (run) => run(conn),
    ...handlers,
  } as SurrealConn;
  return conn;
}

function pageRow(id: string, title: string, widgets: DashboardWidget[]) {
  return {
    id: new RecordId("dashboard_page", id),
    title,
    slug: title.toLowerCase(),
    workbook: new RecordId("workbook", "wb1"),
    widgets,
    updated_at: new Date("2026-06-01T00:00:00Z"),
  };
}

function setup(handlers: Parameters<typeof fakeConn>[0] = {}) {
  const calls: QueryCall[] = [];
  const snapshots: DashboardStoreSnapshot[] = [];
  const conn = fakeConn(handlers, calls);
  const store = createDashboardStore({
    getConn: () => conn,
    onChange: (snapshot) => snapshots.push(snapshot),
  });
  return { store, calls, snapshots };
}

describe("open — 列页、选首页、逐 widget 直连执行聚合", () => {
  test("有页有 widget：pages/activePage 就位，widgetData 按 widget id 装结果", async () => {
    const { store, calls } = setup({
      onQuery: (sql) => {
        if (sql.startsWith("SELECT * FROM dashboard_page")) {
          return [pageRow("p1", "overview", [kpiWidget, barWidget]), pageRow("p2", "trend", [])];
        }
        if (sql === "SELECT * FROM $page") return [pageRow("p1", "overview", [kpiWidget, barWidget])];
        if (sql.includes("math::sum(amount)")) return [{ value: 1234 }];
        if (sql.includes("GROUP BY status")) {
          return [{ key: "已确认", label: "已确认", value: 3 }];
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
    });

    await store.open({ workbookId: "workbook:wb1" });

    expect(store.state.loading).toBe(false);
    expect(store.state.error).toBeNull();
    expect(store.state.pages.map((p) => p.id)).toEqual(["dashboard_page:p1", "dashboard_page:p2"]);
    expect(store.state.activePageId).toBe("dashboard_page:p1");
    expect(store.state.activePage?.widgets).toHaveLength(2);
    expect(store.state.widgetData.w1).toEqual({
      status: "ok",
      result: { value: 1234, label: "amount 总和" },
      updatedAt: expect.any(String),
    });
    expect(store.state.widgetData.w2?.status).toBe("ok");
    // 列表查询走 workbook 作用域
    expect(calls[0].sql).toContain("workbook = $wb");
  });
});

describe("open — 空态与错误", () => {
  test("无任何页：activePage 为 null，无报错（空态由 UI 呈现，不自动建页）", async () => {
    const { store, calls } = setup({ onQuery: () => [] });

    await store.open({ workbookId: "workbook:wb1" });

    expect(store.state.error).toBeNull();
    expect(store.state.pages).toEqual([]);
    expect(store.state.activePageId).toBeNull();
    expect(store.state.activePage).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("单个 widget 查询失败只标记该卡，其余正常", async () => {
    const { store } = setup({
      onQuery: (sql) => {
        if (sql.startsWith("SELECT * FROM dashboard_page")) return [pageRow("p1", "overview", [kpiWidget, barWidget])];
        if (sql === "SELECT * FROM $page") return [pageRow("p1", "overview", [kpiWidget, barWidget])];
        if (sql.includes("math::sum(amount)")) throw new Error("Unknown field amount");
        return [{ key: "已确认", label: "已确认", value: 3 }];
      },
    });

    await store.open({ workbookId: "workbook:wb1" });

    expect(store.state.error).toBeNull();
    expect(store.state.widgetData.w1).toEqual({ status: "error", message: "Unknown field amount" });
    expect(store.state.widgetData.w2?.status).toBe("ok");
  });
});

describe("selectPage / refresh — 切页与前端重跑聚合", () => {
  function multiPageHandlers() {
    return {
      onQuery: (sql: string, bindings?: Record<string, unknown>) => {
        if (sql.startsWith("SELECT * FROM dashboard_page")) {
          return [pageRow("p1", "overview", [kpiWidget]), pageRow("p2", "trend", [barWidget])];
        }
        if (sql === "SELECT * FROM $page") {
          return String(bindings?.page) === "dashboard_page:p2"
            ? [pageRow("p2", "trend", [barWidget])]
            : [pageRow("p1", "overview", [kpiWidget])];
        }
        if (sql.includes("math::sum(amount)")) return [{ value: 7 }];
        return [{ key: "已确认", label: "已确认", value: 3 }];
      },
    };
  }

  test("selectPage 加载目标页并执行其 widgets，旧页 widgetData 清空", async () => {
    const { store } = setup(multiPageHandlers());
    await store.open({ workbookId: "workbook:wb1" });

    await store.selectPage("dashboard_page:p2");

    expect(store.state.activePageId).toBe("dashboard_page:p2");
    expect(store.state.activePage?.widgets).toEqual([barWidget]);
    expect(store.state.widgetData.w1).toBeUndefined();
    expect(store.state.widgetData.w2?.status).toBe("ok");
  });

  test("refresh 重跑当前页全部 widget 查询，不发起任何写语句", async () => {
    const { store, calls } = setup(multiPageHandlers());
    await store.open({ workbookId: "workbook:wb1" });
    const before = calls.length;

    await store.refresh();

    const newCalls = calls.slice(before);
    expect(newCalls).toHaveLength(1);
    expect(newCalls[0].sql).toContain("math::sum(amount)");
    expect(newCalls[0].sql.startsWith("SELECT")).toBe(true);
  });
});

describe("createPage / renamePage / deletePage — page 生命周期直连", () => {
  test("createPage 成功：新页插到列表头并成为当前页（带 workbook 作用域）", async () => {
    const created: Array<Record<string, unknown>> = [];
    const { store } = setup({
      onQuery: (sql) => (sql.startsWith("SELECT * FROM dashboard_page") ? [] : []),
      createRecord: (async (_table: string, data: Record<string, unknown>) => {
        created.push(data);
        return { id: new RecordId("dashboard_page", "new"), ...data };
      }) as SurrealConn["createRecord"],
    });
    await store.open({ workbookId: "workbook:wb1" });

    const result = await store.createPage("月度概览");

    expect(result.ok).toBe(true);
    expect(String(created[0].workbook)).toBe("workbook:wb1");
    expect(store.state.pages.map((p) => p.id)).toEqual(["dashboard_page:new"]);
    expect(store.state.activePageId).toBe("dashboard_page:new");
    expect(store.state.activePage?.widgets).toEqual([]);
  });

  test("createPage 被 PERMISSIONS 拒绝：返回中文错误，列表不变", async () => {
    const { store } = setup({
      onQuery: () => [],
      createRecord: (async () => {
        throw new Error("There was a problem with permissions");
      }) as SurrealConn["createRecord"],
    });
    await store.open({ workbookId: "workbook:wb1" });

    const result = await store.createPage("x");

    expect(result).toEqual({
      ok: false,
      message: "没有权限执行该操作（仅工作区管理员可管理仪表盘页）",
    });
    expect(store.state.pages).toEqual([]);
    expect(store.state.saving).toBe(false);
  });

  test("renamePage 更新列表与当前页标题", async () => {
    const { store } = setup({
      onQuery: (sql) => {
        if (sql.startsWith("SELECT * FROM dashboard_page")) return [pageRow("p1", "overview", [])];
        if (sql === "SELECT * FROM $page") return [pageRow("p1", "overview", [])];
        return [];
      },
      updateRecord: (async (_id: string, patch: Record<string, unknown>) => ({
        ...pageRow("p1", String(patch.title), []),
      })) as SurrealConn["updateRecord"],
    });
    await store.open({ workbookId: "workbook:wb1" });

    const result = await store.renamePage("dashboard_page:p1", "新概览");

    expect(result.ok).toBe(true);
    expect(store.state.pages[0]?.title).toBe("新概览");
    expect(store.state.activePage?.title).toBe("新概览");
  });

  test("deletePage 删当前页后自动切到剩余首页；删最后一页清空", async () => {
    const { store } = setup(
      {
        onQuery: (sql, bindings) => {
          if (sql.startsWith("SELECT * FROM dashboard_page")) {
            return [pageRow("p1", "overview", []), pageRow("p2", "trend", [])];
          }
          if (sql === "SELECT * FROM $page") {
            return String(bindings?.page) === "dashboard_page:p2"
              ? [pageRow("p2", "trend", [])]
              : [pageRow("p1", "overview", [])];
          }
          return [];
        },
      },
    );
    await store.open({ workbookId: "workbook:wb1" });

    const first = await store.deletePage("dashboard_page:p1");
    expect(first.ok).toBe(true);
    expect(store.state.pages.map((p) => p.id)).toEqual(["dashboard_page:p2"]);
    expect(store.state.activePageId).toBe("dashboard_page:p2");

    const last = await store.deletePage("dashboard_page:p2");
    expect(last.ok).toBe(true);
    expect(store.state.pages).toEqual([]);
    expect(store.state.activePageId).toBeNull();
    expect(store.state.activePage).toBeNull();
  });
});

describe("upsertWidget / removeWidget — 保存 = 覆盖 dashboard_page.widgets[]", () => {
  function widgetWriteSetup(over: Partial<SurrealConn> = {}) {
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const ctx = setup({
      onQuery: (sql) => {
        if (sql.startsWith("SELECT * FROM dashboard_page")) return [pageRow("p1", "overview", [kpiWidget])];
        if (sql === "SELECT * FROM $page") return [pageRow("p1", "overview", [kpiWidget])];
        if (sql.includes("math::sum(amount)")) return [{ value: 7 }];
        return [{ key: "已确认", label: "已确认", value: 3 }];
      },
      updateRecord: (async (id: string, patch: Record<string, unknown>) => {
        updates.push({ id, patch });
        return { ...pageRow("p1", "overview", patch.widgets as DashboardWidget[]) };
      }) as SurrealConn["updateRecord"],
      ...over,
    });
    return { ...ctx, updates };
  }

  test("新增 widget：追加保存并只执行新卡的查询", async () => {
    const { store, updates, calls } = widgetWriteSetup();
    await store.open({ workbookId: "workbook:wb1" });
    const before = calls.length;

    const result = await store.upsertWidget(barWidget);

    expect(result.ok).toBe(true);
    expect(updates[0].id).toBe("dashboard_page:p1");
    expect(updates[0].patch).toEqual({ widgets: [kpiWidget, barWidget] });
    expect(store.state.activePage?.widgets).toEqual([kpiWidget, barWidget]);
    expect(store.state.widgetData.w2?.status).toBe("ok");
    const aggregates = calls.slice(before).filter((c) => c.sql.includes("GROUP BY status"));
    expect(aggregates).toHaveLength(1);
  });

  test("编辑既有 widget：按 id 替换并重跑该卡", async () => {
    const { store, updates } = widgetWriteSetup();
    await store.open({ workbookId: "workbook:wb1" });

    const edited = { ...kpiWidget, title: "改过的标题" };
    const result = await store.upsertWidget(edited);

    expect(result.ok).toBe(true);
    expect(updates[0].patch).toEqual({ widgets: [edited] });
    expect(store.state.activePage?.widgets).toEqual([edited]);
  });

  test("移除 widget：整组覆盖保存并清掉该卡数据", async () => {
    const { store, updates } = widgetWriteSetup();
    await store.open({ workbookId: "workbook:wb1" });

    const result = await store.removeWidget("w1");

    expect(result.ok).toBe(true);
    expect(updates[0].patch).toEqual({ widgets: [] });
    expect(store.state.activePage?.widgets).toEqual([]);
    expect(store.state.widgetData.w1).toBeUndefined();
  });

  test("写入被 PERMISSIONS 拒绝：返回中文错误，本地 widgets 不变", async () => {
    const { store } = widgetWriteSetup({
      updateRecord: (async () => {
        throw new Error("There was a problem with permissions");
      }) as SurrealConn["updateRecord"],
    });
    await store.open({ workbookId: "workbook:wb1" });

    const result = await store.upsertWidget(barWidget);

    expect(result).toEqual({
      ok: false,
      message: "没有权限执行该操作（仅工作区管理员可管理仪表盘页）",
    });
    expect(store.state.activePage?.widgets).toEqual([kpiWidget]);
  });
});
