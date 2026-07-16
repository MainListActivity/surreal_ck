import { describe, expect, test } from "bun:test";
import type { DashboardBuilderSpec, DashboardDraftIntent, DashboardPreviewResponse } from "@surreal-ck/shared";
import type { DashboardWidget } from "../../../lib/dashboard-data";
import { compileDashboardWidgetQuery } from "../../../lib/dashboard-query";
import type { SurrealConn } from "../../../lib/surreal";
import {
  createDashboardDraftCard,
  persistDashboardDraft,
  previewDashboardDraft,
  widgetFromDashboardDraft,
  type PersistDashboardDraftResult,
} from "./dashboard-draft-card";

/** 仅实现草稿卡用到的 SurrealConn 窄接口。 */
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
    updateRecord: async (_id: string, patch: Record<string, unknown>) => patch,
    createRecord: async (_table: string, data: Record<string, unknown>) => data,
    deleteRecord: async () => ({}),
    transaction: async (run) => run(conn),
    ...over,
  } as SurrealConn;
  return conn;
}

function draftSpec(over: Partial<DashboardBuilderSpec> = {}): DashboardBuilderSpec {
  return {
    sourceTables: ["ent_claim"],
    baseTable: "ent_claim",
    metric: { op: "sum", field: "amount" },
    dimensions: [{ field: "declared_at", bucket: "month" }],
    limit: 24,
    ...over,
  };
}

function draftIntent(over: Partial<DashboardDraftIntent> = {}): DashboardDraftIntent {
  const widgetSpec = draftSpec();
  return {
    type: "dashboard-draft",
    title: "申报金额月趋势",
    description: "按月统计债权申报金额",
    widgetSpec,
    draft: {
      workspaceId: "workspace:main",
      workbookId: "workbook:claims",
      title: "申报金额月趋势",
      description: "按月统计债权申报金额",
      queryMode: "builder",
      viewType: "line",
      resultContract: "time_series",
      builderSpec: widgetSpec,
      status: "draft",
    },
    explanation: "基于债权表，按月对申报金额求和。",
    ...over,
  };
}

function existingWidget(id: string): DashboardWidget {
  return {
    id,
    title: `已有 ${id}`,
    viewType: "bar",
    spec: draftSpec({ dimensions: [{ field: "status" }] }),
    grid: { x: 0, y: 0, w: 6, h: 2 },
  };
}

describe("草稿 → DashboardWidget 转换", () => {
  test("spec/viewType/标题原样取自意图（与手工 builder 同口径），按页内已有 widget 数排两列流式布局", () => {
    const intent = draftIntent();
    const widget = widgetFromDashboardDraft(intent, [
      existingWidget("w1"),
      existingWidget("w2"),
      existingWidget("w3"),
    ]);

    expect(widget.id).toMatch(/^widget_/);
    expect(widget.title).toBe("申报金额月趋势");
    expect(widget.viewType).toBe("line");
    expect(widget.spec).toEqual(intent.widgetSpec);
    expect(widget.grid).toEqual({ x: 6, y: 2, w: 6, h: 2 });
    // 产出可直接喂给 D3-02 编译器——不存在 AI 专用的第二套 widget 描述
    expect(() => compileDashboardWidgetQuery(widget)).not.toThrow();
  });
});

describe("草稿 → 预览查询", () => {
  test("以当前会话执行 D3-02 编译出的参数化聚合 SELECT（只读，无写语句），归一结果按 draft 契约返回", async () => {
    const intent = draftIntent();
    const calls: Array<{ sql: string; bindings?: Record<string, unknown> }> = [];
    const conn = fakeConn({
      query: (async (sql: string, bindings?: Record<string, unknown>) => {
        calls.push({ sql, bindings });
        return [
          { x: "2026-01", y: 120 },
          { x: "2026-02", y: 80 },
        ];
      }) as SurrealConn["query"],
    });

    const preview = await previewDashboardDraft(conn, intent);

    const compiled = compileDashboardWidgetQuery({
      spec: intent.widgetSpec,
      viewType: intent.draft.viewType,
      display: intent.draft.displaySpec,
    });
    expect(calls).toEqual([{ sql: compiled.sql, bindings: compiled.bindings }]);
    expect(calls[0].sql.startsWith("SELECT ")).toBe(true);
    expect(calls[0].sql).not.toMatch(/\b(CREATE|UPDATE|UPSERT|DELETE|INSERT|RELATE|DEFINE|REMOVE)\b/i);
    expect(preview.result).toEqual({ rows: [{ x: "2026-01", y: 120 }, { x: "2026-02", y: 80 }] });
    expect(preview.resultMeta).toEqual({ contract: "time_series", viewType: "line" });
  });
});

describe("草稿 → dashboard_page 持久化", () => {
  test("作用域内没有页：先以草稿标题新建页（带 workbook 作用域），再整组覆盖写入含新 widget 的 widgets", async () => {
    const intent = draftIntent();
    const queries: Array<{ sql: string; bindings?: Record<string, unknown> }> = [];
    const created: Array<{ table: string; data: Record<string, unknown> }> = [];
    const merged: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const conn = fakeConn({
      query: (async (sql: string, bindings?: Record<string, unknown>) => {
        queries.push({ sql, bindings });
        return [];
      }) as SurrealConn["query"],
      createRecord: (async (table: string, data: Record<string, unknown>) => {
        created.push({ table, data });
        return { id: "dashboard_page:p1", title: data.title, slug: data.slug, widgets: [] };
      }) as SurrealConn["createRecord"],
      updateRecord: (async (id: string, patch: Record<string, unknown>) => {
        merged.push({ id, patch });
        return { id: "dashboard_page:p1", title: intent.title, slug: "page-x", widgets: patch.widgets };
      }) as SurrealConn["updateRecord"],
    });

    const result = await persistDashboardDraft(conn, intent);

    expect(queries[0].sql).toContain("workbook = $wb");
    expect(created).toHaveLength(1);
    expect(created[0].table).toBe("dashboard_page");
    expect(created[0].data.title).toBe("申报金额月趋势");
    expect(String(created[0].data.workbook)).toBe("workbook:claims");
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("dashboard_page:p1");
    const widgets = merged[0].patch.widgets as DashboardWidget[];
    expect(widgets).toHaveLength(1);
    expect(widgets[0].spec).toEqual(intent.widgetSpec);
    expect(widgets[0].grid).toEqual({ x: 0, y: 0, w: 6, h: 2 });
    expect(result).toEqual({
      ok: true,
      pageId: "dashboard_page:p1",
      pageTitle: "申报金额月趋势",
      widgetId: widgets[0].id,
      createdPage: true,
    });
  });

  test("作用域内已有页：向最近更新的页追加 widget，保留既有 widgets，不新建页", async () => {
    const intent = draftIntent();
    const w1 = existingWidget("w1");
    const created: unknown[] = [];
    const merged: Array<{ id: string; patch: Record<string, unknown> }> = [];
    let queryCount = 0;
    const conn = fakeConn({
      query: (async () => {
        queryCount += 1;
        if (queryCount === 1) {
          // listDashboardPages：最近更新的排最前
          return [
            { id: "dashboard_page:recent", title: "经营概览", slug: "overview", widgets: [] },
            { id: "dashboard_page:older", title: "旧页", slug: "old", widgets: [] },
          ];
        }
        // loadDashboardPage
        return [{ id: "dashboard_page:recent", title: "经营概览", slug: "overview", widgets: [w1] }];
      }) as SurrealConn["query"],
      createRecord: (async (table: string, data: Record<string, unknown>) => {
        created.push({ table, data });
        return data;
      }) as SurrealConn["createRecord"],
      updateRecord: (async (id: string, patch: Record<string, unknown>) => {
        merged.push({ id, patch });
        return { id: "dashboard_page:recent", title: "经营概览", slug: "overview", widgets: patch.widgets };
      }) as SurrealConn["updateRecord"],
    });

    const result = await persistDashboardDraft(conn, intent);

    expect(created).toHaveLength(0);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("dashboard_page:recent");
    const widgets = merged[0].patch.widgets as DashboardWidget[];
    expect(widgets).toHaveLength(2);
    expect(widgets[0]).toEqual(w1);
    expect(widgets[1].spec).toEqual(intent.widgetSpec);
    expect(widgets[1].grid).toEqual({ x: 6, y: 0, w: 6, h: 2 });
    expect(result).toEqual({
      ok: true,
      pageId: "dashboard_page:recent",
      pageTitle: "经营概览",
      widgetId: widgets[1].id,
      createdPage: false,
    });
  });

  test("写入被 PERMISSIONS 拒绝：透传 D3-01 数据层的中文错误，不预判 is_admin", async () => {
    const conn = fakeConn({
      query: (async () => []) as SurrealConn["query"],
      createRecord: (async () => {
        throw new Error("There was a problem with the database: IAM error: Not enough permissions");
      }) as SurrealConn["createRecord"],
    });

    const result = await persistDashboardDraft(conn, draftIntent());

    expect(result).toEqual({
      ok: false,
      message: "没有权限执行该操作（仅工作区管理员可管理仪表盘页）",
    });
  });
});

function previewResponse(): DashboardPreviewResponse {
  return {
    sql: "SELECT 1",
    sourceTables: ["ent_claim"],
    dependencies: ["ent_claim"],
    durationMs: 5,
    rowsCount: 1,
    result: { rows: [{ x: "2026-01", y: 120 }] },
    resultMeta: { contract: "time_series", viewType: "line" },
    sqlHash: "deadbeef",
  };
}

function cardHarness(input: {
  intent?: DashboardDraftIntent;
  preview?: () => Promise<DashboardPreviewResponse>;
  save?: () => Promise<PersistDashboardDraftResult>;
  resume?: (decision: { kind: "write-confirmed" | "write-rejected" }) => Promise<void>;
} = {}) {
  let saves = 0;
  const resumes: Array<{ kind: "write-confirmed" | "write-rejected" }> = [];
  const card = createDashboardDraftCard({
    intent: input.intent ?? draftIntent(),
    preview: input.preview ?? (async () => previewResponse()),
    save: input.save ?? (async () => {
      saves += 1;
      return { ok: true, pageId: "dashboard_page:p1", pageTitle: "经营概览", widgetId: "widget_x", createdPage: false };
    }),
    resume: input.resume ?? (async (decision) => {
      resumes.push(decision);
    }),
  });
  return { card, saveCount: () => saves, resumes };
}

describe("草稿卡状态机", () => {
  test("预览成功：previewing → ready，携带真实数据预览结果", async () => {
    const { card } = cardHarness();
    expect(card.snapshot().status).toBe("previewing");

    await card.loadPreview();

    const state = card.snapshot();
    expect(state.status).toBe("ready");
    expect(state.preview).toEqual(previewResponse());
    expect(state.error).toBeNull();
  });

  test("确认保存：save 成功后以 write-confirmed resume，终态 done 并携带保存去向", async () => {
    const { card, saveCount, resumes } = cardHarness();
    await card.loadPreview();

    await card.confirm();

    expect(saveCount()).toBe(1);
    expect(resumes).toEqual([{ kind: "write-confirmed" }]);
    const state = card.snapshot();
    expect(state.status).toBe("done");
    expect(state.saved).toEqual({ pageId: "dashboard_page:p1", pageTitle: "经营概览", createdPage: false });
    expect(state.error).toBeNull();
  });

  test("忽略草稿：不调 save、以 write-rejected resume，终态 rejected——不产生任何 dashboard 记录", async () => {
    const { card, saveCount, resumes } = cardHarness();
    await card.loadPreview();

    await card.reject();

    expect(saveCount()).toBe(0);
    expect(resumes).toEqual([{ kind: "write-rejected" }]);
    expect(card.snapshot().status).toBe("rejected");
  });

  test("预览失败（schema 漂移 / 聚合不合法）：preview-error 展示错误，confirm 是 no-op，仍可忽略", async () => {
    const { card, saveCount, resumes } = cardHarness({
      preview: async () => {
        throw new Error("非法的分组字段: declared_at");
      },
    });

    await card.loadPreview();
    let state = card.snapshot();
    expect(state.status).toBe("preview-error");
    expect(state.error).toBe("非法的分组字段: declared_at");

    await card.confirm();
    expect(saveCount()).toBe(0);
    expect(resumes).toEqual([]);
    expect(card.snapshot().status).toBe("preview-error");

    await card.reject();
    expect(resumes).toEqual([{ kind: "write-rejected" }]);
    expect(card.snapshot().status).toBe("rejected");
  });

  test("保存失败（含 PERMISSIONS 拒绝）：error 态展示中文错误且不 resume，卡片保留可重试", async () => {
    let attempts = 0;
    const { card, resumes } = cardHarness({
      save: async () => {
        attempts += 1;
        if (attempts === 1) {
          return { ok: false, message: "没有权限执行该操作（仅工作区管理员可管理仪表盘页）" };
        }
        return { ok: true, pageId: "dashboard_page:p1", pageTitle: "经营概览", widgetId: "widget_x", createdPage: true };
      },
    });
    await card.loadPreview();

    await card.confirm();
    let state = card.snapshot();
    expect(state.status).toBe("error");
    expect(state.error).toBe("没有权限执行该操作（仅工作区管理员可管理仪表盘页）");
    expect(resumes).toEqual([]);

    await card.confirm();
    state = card.snapshot();
    expect(state.status).toBe("done");
    expect(resumes).toEqual([{ kind: "write-confirmed" }]);
  });

  test("resume 失败：保留已保存结果，再次提交只重试决定而不重复保存", async () => {
    let failResume = true;
    const { card, saveCount } = cardHarness({
      resume: async () => {
        if (failResume) {
          failResume = false;
          throw new Error("AI 会话续跑失败。");
        }
      },
    });
    await card.loadPreview();

    await card.confirm();

    const state = card.snapshot();
    expect(saveCount()).toBe(1);
    expect(state.status).toBe("error");
    expect(state.error).toBe("AI 会话续跑失败。");

    await card.confirm();

    expect(saveCount()).toBe(1);
    expect(card.snapshot().status).toBe("done");
  });
});
