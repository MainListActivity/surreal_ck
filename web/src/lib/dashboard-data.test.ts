import { describe, expect, test } from "bun:test";
import { RecordId, StringRecordId } from "surrealdb";
import type { SurrealConn } from "./surreal";
import {
  createDashboardPage,
  deleteDashboardPage,
  listDashboardPages,
  loadDashboardPage,
  renameDashboardPage,
  saveDashboardPageWidgets,
  type DashboardWidget,
} from "./dashboard-data";

const kpiWidget: DashboardWidget = {
  id: "w1",
  title: "债权总额",
  viewType: "kpi",
  spec: { sourceTables: ["ent_claim"], baseTable: "ent_claim", metric: { op: "sum", field: "amount" } },
  grid: { x: 0, y: 0, w: 4, h: 2 },
};

/** 仅实现数据层用到的 SurrealConn 窄接口。 */
function fakeConn(over: Partial<SurrealConn> = {}): SurrealConn {
  let conn: SurrealConn;
  conn = {
    status: "connected",
    connect: async () => true,
    use: async () => ({}),
    close: async () => true,
    subscribe: () => () => {},
    query: async () => [],
    liveTable: async () => () => {},
    updateRecord: async (_id, patch) => patch,
    createRecord: async (_table, data) => data,
    deleteRecord: async () => ({}),
    transaction: async (run) => run(conn),
    ...over,
  } as SurrealConn;
  return conn;
}

describe("listDashboardPages — 直连 SELECT 列出 dashboard 页", () => {
  test("workspace 级（无 workbook）：WHERE workbook IS NONE，倒序，映射 summary DTO", async () => {
    const calls: Array<{ sql: string; bindings: unknown }> = [];
    const conn = fakeConn({
      query: (async (sql: string, bindings?: Record<string, unknown>) => {
        calls.push({ sql, bindings });
        return [
          {
            id: new RecordId("dashboard_page", "p1"),
            title: "概览",
            slug: "overview",
            widgets: [],
            updated_at: new Date("2026-06-01T00:00:00Z"),
          },
        ];
      }) as SurrealConn["query"],
    });

    const pages = await listDashboardPages(conn, {});

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toBe(
      "SELECT * FROM dashboard_page WHERE workbook IS NONE ORDER BY updated_at DESC",
    );
    expect(calls[0].bindings).toEqual({});
    expect(pages).toEqual([
      {
        id: "dashboard_page:p1",
        title: "概览",
        slug: "overview",
        updatedAt: "2026-06-01T00:00:00.000Z",
      },
    ]);
  });

  test("workbook 级：WHERE workbook = $wb，绑定值包成 RecordId，summary 带 workbookId", async () => {
    const calls: Array<{ sql: string; bindings: Record<string, unknown> | undefined }> = [];
    const conn = fakeConn({
      query: (async (sql: string, bindings?: Record<string, unknown>) => {
        calls.push({ sql, bindings });
        return [
          {
            id: new RecordId("dashboard_page", "p2"),
            title: "债权统计",
            slug: "claims",
            workbook: new RecordId("workbook", "wb1"),
            widgets: [],
            updated_at: new Date("2026-06-02T00:00:00Z"),
          },
        ];
      }) as SurrealConn["query"],
    });

    const pages = await listDashboardPages(conn, { workbookId: "workbook:wb1" });

    expect(calls[0].sql).toBe(
      "SELECT * FROM dashboard_page WHERE workbook = $wb ORDER BY updated_at DESC",
    );
    expect(calls[0].bindings?.wb).toBeInstanceOf(StringRecordId);
    expect(String(calls[0].bindings?.wb)).toBe("workbook:wb1");
    expect(pages).toEqual([
      {
        id: "dashboard_page:p2",
        title: "债权统计",
        slug: "claims",
        workbookId: "workbook:wb1",
        updatedAt: "2026-06-02T00:00:00.000Z",
      },
    ]);
  });
});

describe("loadDashboardPage — 读单页含 widgets", () => {
  test("按 RecordId 选中单条，widgets 原样带回", async () => {
    const calls: Array<{ sql: string; bindings: Record<string, unknown> | undefined }> = [];
    const conn = fakeConn({
      query: (async (sql: string, bindings?: Record<string, unknown>) => {
        calls.push({ sql, bindings });
        return [
          {
            id: new RecordId("dashboard_page", "p1"),
            title: "概览",
            slug: "overview",
            widgets: [kpiWidget],
            updated_at: new Date("2026-06-01T00:00:00Z"),
          },
        ];
      }) as SurrealConn["query"],
    });

    const page = await loadDashboardPage(conn, "dashboard_page:p1");

    expect(calls[0].sql).toBe("SELECT * FROM $page");
    expect(calls[0].bindings?.page).toBeInstanceOf(StringRecordId);
    expect(String(calls[0].bindings?.page)).toBe("dashboard_page:p1");
    expect(page).toEqual({
      id: "dashboard_page:p1",
      title: "概览",
      slug: "overview",
      widgets: [kpiWidget],
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
  });

  test("记录不存在时返回 null", async () => {
    const conn = fakeConn({ query: (async () => []) as SurrealConn["query"] });
    expect(await loadDashboardPage(conn, "dashboard_page:gone")).toBeNull();
  });
});

describe("createDashboardPage — 直连 CREATE，slug 由 title 派生", () => {
  test("拉丁标题派生 kebab slug，workbook 包成 RecordId，返回新页", async () => {
    const created: Array<{ table: string; data: Record<string, unknown> }> = [];
    const conn = fakeConn({
      createRecord: (async (table: string, data: Record<string, unknown>) => {
        created.push({ table, data });
        return {
          id: new RecordId("dashboard_page", "p9"),
          ...data,
          updated_at: new Date("2026-06-12T00:00:00Z"),
        };
      }) as SurrealConn["createRecord"],
    });

    const result = await createDashboardPage(conn, {
      title: "Claims Overview",
      workbookId: "workbook:wb1",
    });

    expect(created[0].table).toBe("dashboard_page");
    expect(created[0].data.title).toBe("Claims Overview");
    expect(created[0].data.slug).toBe("claims-overview");
    expect(created[0].data.widgets).toEqual([]);
    expect(created[0].data.workbook).toBeInstanceOf(StringRecordId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.page.id).toBe("dashboard_page:p9");
      expect(result.page.workbookId).toBe("workbook:wb1");
      expect(result.page.widgets).toEqual([]);
    }
  });

  test("中文标题派生不出拉丁 slug 时回退 page-随机后缀；workspace 级不带 workbook 字段", async () => {
    const created: Array<Record<string, unknown>> = [];
    const conn = fakeConn({
      createRecord: (async (_table: string, data: Record<string, unknown>) => {
        created.push(data);
        return { id: new RecordId("dashboard_page", "p10"), ...data };
      }) as SurrealConn["createRecord"],
    });

    const result = await createDashboardPage(conn, { title: "概览" });

    expect(String(created[0].slug)).toMatch(/^page-[a-z0-9]+$/);
    expect("workbook" in created[0]).toBe(false);
    expect(result.ok).toBe(true);
  });

  test("撞 (workbook, slug) 唯一索引时返回可读错误，不抛异常", async () => {
    const conn = fakeConn({
      createRecord: (async () => {
        throw new Error(
          "Database index `dashboard_page_slug_unique` already contains ['workbook:wb1', 'overview']",
        );
      }) as SurrealConn["createRecord"],
    });

    const result = await createDashboardPage(conn, { title: "Overview", workbookId: "workbook:wb1" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe("同名仪表盘页已存在，请换一个标题");
  });
});

describe("renameDashboardPage — 只改 title，slug 保持稳定", () => {
  test("MERGE 更新 title，patch 不含 slug，返回更新后的页", async () => {
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const conn = fakeConn({
      updateRecord: (async (id: string, patch: Record<string, unknown>) => {
        updates.push({ id, patch });
        return {
          id: new RecordId("dashboard_page", "p1"),
          title: patch.title,
          slug: "overview",
          widgets: [],
        };
      }) as SurrealConn["updateRecord"],
    });

    const result = await renameDashboardPage(conn, "dashboard_page:p1", "新概览");

    expect(updates[0].id).toBe("dashboard_page:p1");
    expect(updates[0].patch).toEqual({ title: "新概览" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.page.slug).toBe("overview");
  });

  test("普通成员被 PERMISSIONS 拒绝时翻译成中文提示", async () => {
    const conn = fakeConn({
      updateRecord: (async () => {
        throw new Error("There was a problem with permissions");
      }) as SurrealConn["updateRecord"],
    });

    const result = await renameDashboardPage(conn, "dashboard_page:p1", "x");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe("没有权限执行该操作（仅工作区管理员可管理仪表盘页）");
  });
});

describe("saveDashboardPageWidgets — 整组覆盖 widgets（新增/删除/布局统一入口）", () => {
  test("MERGE 写整组 widgets，返回更新后的页", async () => {
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const conn = fakeConn({
      updateRecord: (async (id: string, patch: Record<string, unknown>) => {
        updates.push({ id, patch });
        return {
          id: new RecordId("dashboard_page", "p1"),
          title: "概览",
          slug: "overview",
          widgets: patch.widgets,
        };
      }) as SurrealConn["updateRecord"],
    });

    const result = await saveDashboardPageWidgets(conn, "dashboard_page:p1", [kpiWidget]);

    expect(updates[0].id).toBe("dashboard_page:p1");
    expect(updates[0].patch).toEqual({ widgets: [kpiWidget] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.page.widgets).toEqual([kpiWidget]);
  });

  test("引擎拒绝时返回 ok:false 可读错误", async () => {
    const conn = fakeConn({
      updateRecord: (async () => {
        throw new Error("Not allowed to do this");
      }) as SurrealConn["updateRecord"],
    });

    const result = await saveDashboardPageWidgets(conn, "dashboard_page:p1", []);

    expect(result.ok).toBe(false);
  });
});

describe("deleteDashboardPage — 直连删除", () => {
  test("按 RecordId 删除，成功返回 ok:true", async () => {
    const deleted: string[] = [];
    const conn = fakeConn({
      deleteRecord: (async (id: string) => {
        deleted.push(id);
        return {};
      }) as SurrealConn["deleteRecord"],
    });

    const result = await deleteDashboardPage(conn, "dashboard_page:p1");

    expect(deleted).toEqual(["dashboard_page:p1"]);
    expect(result).toEqual({ ok: true });
  });

  test("引擎拒绝时翻译错误", async () => {
    const conn = fakeConn({
      deleteRecord: (async () => {
        throw new Error("There was a problem with permissions");
      }) as SurrealConn["deleteRecord"],
    });

    const result = await deleteDashboardPage(conn, "dashboard_page:p1");

    expect(result).toEqual({
      ok: false,
      message: "没有权限执行该操作（仅工作区管理员可管理仪表盘页）",
    });
  });
});
