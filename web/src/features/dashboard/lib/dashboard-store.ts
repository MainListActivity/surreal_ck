import type { DashboardNormalizedResult } from "@surreal-ck/shared/rpc.types";
import {
  createDashboardPage,
  deleteDashboardPage,
  listDashboardPages,
  loadDashboardPage,
  renameDashboardPage,
  saveDashboardPageWidgets,
  type DashboardPage,
  type DashboardPageResult,
  type DashboardPageScope,
  type DashboardPageSummary,
  type DashboardWidget,
} from "../../../lib/dashboard-data";
import { runDashboardWidgetQuery } from "../../../lib/dashboard-query";
import type { SurrealConn } from "../../../lib/surreal";
import type { SaveResult } from "../../../lib/workbook-data";

/** 单个 widget 的直连聚合执行态；error 不拖垮整页，逐卡显示。 */
export type DashboardWidgetData =
  | { status: "loading" }
  | { status: "ok"; result: DashboardNormalizedResult; updatedAt: string }
  | { status: "error"; message: string };

export type DashboardStoreState = {
  loading: boolean;
  saving: boolean;
  error: string | null;
  workbookId: string | null;
  pages: DashboardPageSummary[];
  activePageId: string | null;
  activePage: DashboardPage | null;
  widgetData: Record<string, DashboardWidgetData>;
};

export type DashboardStoreSnapshot = DashboardStoreState;

export type DashboardStoreDeps = {
  getConn: () => SurrealConn;
  /** 镜像进 runes，使组件响应式更新。纯逻辑层不依赖它。 */
  onChange?: (snapshot: DashboardStoreSnapshot) => void;
};

export type DashboardStore = ReturnType<typeof createDashboardStore>;

/**
 * dashboard 屏幕编排层：page 列表 / 切换 / widget 聚合执行全部直连 SurrealDB
 * （D3-01 数据层 + D3-02 查询编译器），无后端缓存、无代理 endpoint。
 * runes 镜像在 dashboard-store.svelte.ts；这里是可单测的纯逻辑工厂。
 */
export function createDashboardStore(deps: DashboardStoreDeps) {
  const state: DashboardStoreState = {
    loading: false,
    saving: false,
    error: null,
    workbookId: null,
    pages: [],
    activePageId: null,
    activePage: null,
    widgetData: {},
  };

  /** 页加载代际：切页后旧页未完成的 widget 查询结果直接丢弃。 */
  let loadGeneration = 0;

  function emit(): void {
    deps.onChange?.({
      ...state,
      pages: [...state.pages],
      widgetData: { ...state.widgetData },
    });
  }

  /** 列出页并进入第一页（或指定页）。workbookId 同时记下来供建页用。 */
  async function open(scope: DashboardPageScope, requestedPageId?: string): Promise<void> {
    state.workbookId = scope.workbookId ?? null;
    state.loading = true;
    state.error = null;
    emit();
    try {
      const pages = await listDashboardPages(deps.getConn(), scope);
      state.pages = pages;
      const nextPageId = requestedPageId && pages.some((page) => page.id === requestedPageId)
        ? requestedPageId
        : pages[0]?.id ?? null;
      if (nextPageId) {
        await loadPage(nextPageId);
      } else {
        state.activePageId = null;
        state.activePage = null;
        state.widgetData = {};
      }
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    } finally {
      state.loading = false;
      emit();
    }
  }

  async function loadPage(pageId: string): Promise<void> {
    const page = await loadDashboardPage(deps.getConn(), pageId);
    if (!page) throw new Error("仪表盘页不存在或不可见");
    state.activePageId = pageId;
    state.activePage = page;
    state.widgetData = {};
    emit();
    await runWidgets(page.widgets);
  }

  /** 并行执行一组 widget 的只读聚合；单卡失败只标记该卡。 */
  async function runWidgets(widgets: DashboardWidget[]): Promise<void> {
    const generation = ++loadGeneration;
    for (const widget of widgets) {
      state.widgetData[widget.id] = { status: "loading" };
    }
    emit();
    await Promise.all(widgets.map(async (widget) => {
      let data: DashboardWidgetData;
      try {
        const preview = await runDashboardWidgetQuery(deps.getConn(), widget);
        data = { status: "ok", result: preview.result, updatedAt: new Date().toISOString() };
      } catch (err) {
        data = { status: "error", message: err instanceof Error ? err.message : String(err) };
      }
      if (generation !== loadGeneration) return;
      state.widgetData[widget.id] = data;
      emit();
    }));
  }

  /** 切到另一页并执行其 widgets；失败写入 state.error。 */
  async function selectPage(pageId: string): Promise<void> {
    state.loading = true;
    state.error = null;
    emit();
    try {
      await loadPage(pageId);
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    } finally {
      state.loading = false;
      emit();
    }
  }

  /** 刷新 = 前端重跑当前页全部聚合查询；无后端缓存可言。 */
  async function refresh(): Promise<void> {
    if (!state.activePage) return;
    await runWidgets(state.activePage.widgets);
  }

  /**
   * 新建页（作用域沿用 open 时的 workbook）并切过去。create 权限由
   * dashboard_page PERMISSIONS 兜底，引擎拒绝时返回中文错误、不动列表。
   */
  async function createPage(title: string): Promise<SaveResult> {
    state.saving = true;
    emit();
    try {
      const result = await createDashboardPage(deps.getConn(), {
        title,
        ...(state.workbookId ? { workbookId: state.workbookId } : {}),
      });
      if (!result.ok) return result;
      state.pages = [summaryOf(result.page), ...state.pages];
      state.activePageId = result.page.id;
      state.activePage = result.page;
      state.widgetData = {};
      loadGeneration += 1;
      emit();
      return { ok: true };
    } finally {
      state.saving = false;
      emit();
    }
  }

  /** 改名只动 title（slug 稳定）；同步列表与当前页。 */
  async function renamePage(pageId: string, title: string): Promise<SaveResult> {
    state.saving = true;
    emit();
    try {
      const result = await renameDashboardPage(deps.getConn(), pageId, title);
      if (!result.ok) return result;
      applyPagePatch(result);
      return { ok: true };
    } finally {
      state.saving = false;
      emit();
    }
  }

  /** 删页；删的是当前页时自动切到剩余首页，没有了就回到空态。 */
  async function deletePage(pageId: string): Promise<SaveResult> {
    state.saving = true;
    emit();
    try {
      const result = await deleteDashboardPage(deps.getConn(), pageId);
      if (!result.ok) return result;
      state.pages = state.pages.filter((page) => page.id !== pageId);
      if (state.activePageId === pageId) {
        const next = state.pages[0];
        if (next) {
          await loadPage(next.id);
        } else {
          state.activePageId = null;
          state.activePage = null;
          state.widgetData = {};
          loadGeneration += 1;
        }
      }
      emit();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    } finally {
      state.saving = false;
      emit();
    }
  }

  /**
   * 新增或编辑 widget：按 id 替换（没有则追加）后整组覆盖保存——AI 草稿（D3-05）
   * 与手工 builder 产出的 widget 走完全相同的入口。成功后只重跑该卡的聚合。
   */
  async function upsertWidget(widget: DashboardWidget): Promise<SaveResult> {
    const page = state.activePage;
    if (!page) return { ok: false, message: "尚未选择仪表盘页" };
    const exists = page.widgets.some((item) => item.id === widget.id);
    const widgets = exists
      ? page.widgets.map((item) => (item.id === widget.id ? widget : item))
      : [...page.widgets, widget];
    const result = await saveWidgets(page.id, widgets);
    if (result.ok) await runWidgets([widget]);
    return result;
  }

  /** 移除 widget：整组覆盖保存，并丢掉该卡的执行数据。 */
  async function removeWidget(widgetId: string): Promise<SaveResult> {
    const page = state.activePage;
    if (!page) return { ok: false, message: "尚未选择仪表盘页" };
    const result = await saveWidgets(page.id, page.widgets.filter((item) => item.id !== widgetId));
    if (result.ok) {
      delete state.widgetData[widgetId];
      emit();
    }
    return result;
  }

  async function saveWidgets(pageId: string, widgets: DashboardWidget[]): Promise<SaveResult> {
    state.saving = true;
    emit();
    try {
      const result = await saveDashboardPageWidgets(deps.getConn(), pageId, widgets);
      if (!result.ok) return result;
      applyPagePatch(result);
      return { ok: true };
    } finally {
      state.saving = false;
      emit();
    }
  }

  function applyPagePatch(result: Extract<DashboardPageResult, { ok: true }>): void {
    state.pages = state.pages.map((page) =>
      page.id === result.page.id ? summaryOf(result.page) : page,
    );
    if (state.activePageId === result.page.id) {
      state.activePage = result.page;
    }
    emit();
  }

  function summaryOf(page: DashboardPage): DashboardPageSummary {
    const { widgets: _widgets, ...summary } = page;
    return summary;
  }

  return {
    /** 测试与镜像层读取用；组件读 runes 镜像。 */
    get state(): DashboardStoreState {
      return state;
    },
    open,
    selectPage,
    refresh,
    createPage,
    renamePage,
    deletePage,
    upsertWidget,
    removeWidget,
  };
}
