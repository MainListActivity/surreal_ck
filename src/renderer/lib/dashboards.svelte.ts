import { appApi } from "./app-api";
import type {
  DashboardCacheDTO,
  DashboardPageDTO,
  DashboardPageSummaryDTO,
  DashboardPreviewResponse,
  DashboardViewDraftDTO,
  DashboardViewDTO,
  DashboardWidgetLayoutDTO,
} from "../../shared/rpc.types";

type DashboardState = {
  loading: boolean;
  saving: boolean;
  error: string | null;
  workspaceId: string | null;
  workbookId: string | null;
  pages: DashboardPageSummaryDTO[];
  activePageId: string | null;
  activePage: DashboardPageDTO | null;
  viewsById: Record<string, DashboardViewDTO>;
  cachesByViewId: Record<string, DashboardCacheDTO>;
  preview: DashboardPreviewResponse | null;
};

function createDashboardsStore() {
  let state = $state<DashboardState>({
    loading: false,
    saving: false,
    error: null,
    workspaceId: null,
    workbookId: null,
    pages: [],
    activePageId: null,
    activePage: null,
    viewsById: {},
    cachesByViewId: {},
    preview: null,
  });

  async function load(workspaceId: string, workbookId?: string, requestedPageId?: string, ensurePage = true) {
    if (!workspaceId) return;
    state.workspaceId = workspaceId;
    state.workbookId = workbookId ?? null;
    state.loading = true;
    state.error = null;
    try {
      const pagesRes = await appApi.listDashboardPages(workspaceId, workbookId);
      if (!pagesRes.ok) {
        state.error = pagesRes.message;
        return;
      }

      let pages = pagesRes.data.pages;
      if (ensurePage && pages.length === 0) {
        const created = await appApi.createDashboardPage(workspaceId, workbookId, "概览");
        if (!created.ok) {
          state.error = created.message;
          return;
        }
        pages = [created.data.page];
      }

      state.pages = pages;
      const nextPageId = requestedPageId && pages.some((page) => page.id === requestedPageId)
        ? requestedPageId
        : pages[0]?.id ?? null;
      state.activePageId = nextPageId;
      if (nextPageId) {
        await loadPage(nextPageId);
      }
    } catch (err) {
      state.error = String(err);
    } finally {
      state.loading = false;
    }
  }

  async function loadPage(pageId: string) {
    state.loading = true;
    state.error = null;
    try {
      const res = await appApi.getDashboardPage(pageId);
      if (!res.ok) {
        state.error = res.message;
        return;
      }
      state.activePageId = pageId;
      state.activePage = res.data.page;
      state.viewsById = Object.fromEntries(res.data.views.map((view) => [view.id, view]));
      state.cachesByViewId = Object.fromEntries(res.data.caches.map((cache) => [cache.viewId, cache]));
    } catch (err) {
      state.error = String(err);
    } finally {
      state.loading = false;
    }
  }

  async function createPage(
    title: string,
    options?: { workspaceId?: string; workbookId?: string | null },
  ) {
    const workspaceId = options?.workspaceId ?? state.workspaceId;
    if (!workspaceId) {
      state.error = "尚未加载工作区，无法创建仪表盘";
      return null;
    }
    const workbookId = options && "workbookId" in options ? options.workbookId : state.workbookId;
    if (!state.workspaceId) state.workspaceId = workspaceId;
    if (workbookId !== undefined && state.workbookId !== workbookId) state.workbookId = workbookId ?? null;
    state.saving = true;
    state.error = null;
    try {
      const res = await appApi.createDashboardPage(workspaceId, workbookId ?? undefined, title);
      if (!res.ok) {
        state.error = res.message;
        return null;
      }
      state.pages = [res.data.page, ...state.pages];
      await loadPage(res.data.page.id);
      return res.data.page;
    } catch (err) {
      state.error = String(err);
      return null;
    } finally {
      state.saving = false;
    }
  }

  async function renamePage(pageId: string, title: string): Promise<boolean> {
    const trimmed = title.trim();
    if (!trimmed) return false;
    const target = state.pages.find((page) => page.id === pageId);
    if (target && target.title === trimmed) return true;
    state.saving = true;
    state.error = null;
    try {
      const res = await appApi.renameDashboardPage(pageId, trimmed);
      if (!res.ok) {
        state.error = res.message;
        return false;
      }
      const updated = res.data.page;
      state.pages = state.pages.map((page) => (page.id === updated.id ? { ...page, title: updated.title, slug: updated.slug, updatedAt: updated.updatedAt } : page));
      if (state.activePage && state.activePage.id === updated.id) {
        state.activePage = { ...state.activePage, title: updated.title, slug: updated.slug, updatedAt: updated.updatedAt };
      }
      return true;
    } catch (err) {
      state.error = String(err);
      return false;
    } finally {
      state.saving = false;
    }
  }

  async function previewView(draft: DashboardViewDraftDTO) {
    state.saving = true;
    state.error = null;
    try {
      const res = await appApi.previewDashboardView(draft);
      if (!res.ok) {
        state.preview = null;
        state.error = res.message;
        return null;
      }
      state.preview = res.data;
      return res.data;
    } catch (err) {
      state.preview = null;
      state.error = String(err);
      return null;
    } finally {
      state.saving = false;
    }
  }

  async function createViewAndAttach(
    draft: DashboardViewDraftDTO,
    widget: Omit<DashboardWidgetLayoutDTO, "viewId">,
  ): Promise<DashboardViewDTO | null> {
    if (!state.activePage) return null;
    state.saving = true;
    state.error = null;
    try {
      const res = await appApi.createDashboardView(draft);
      if (!res.ok) {
        state.error = res.message;
        return null;
      }
      const attachedWidget: DashboardWidgetLayoutDTO = { ...widget, viewId: res.data.view.id };
      const widgets = [...state.activePage.widgets, attachedWidget];
      const layoutRes = await appApi.saveDashboardPageLayout(state.activePage.id, widgets);
      if (!layoutRes.ok) {
        state.error = layoutRes.message;
        return null;
      }
      state.activePage = layoutRes.data.page;
      state.viewsById = { ...state.viewsById, [res.data.view.id]: res.data.view };
      if (res.data.cache) {
        state.cachesByViewId = { ...state.cachesByViewId, [res.data.cache.viewId]: res.data.cache };
      }
      state.preview = null;
      return res.data.view;
    } catch (err) {
      state.error = String(err);
      return null;
    } finally {
      state.saving = false;
    }
  }

  async function refreshPage() {
    if (!state.activePageId) return;
    state.loading = true;
    state.error = null;
    try {
      const res = await appApi.refreshDashboardPage(state.activePageId);
      if (!res.ok) {
        state.error = res.message;
        return;
      }
      state.cachesByViewId = {
        ...state.cachesByViewId,
        ...Object.fromEntries(res.data.caches.map((cache) => [cache.viewId, cache])),
      };
    } catch (err) {
      state.error = String(err);
    } finally {
      state.loading = false;
    }
  }

  async function removeWidget(widgetId: string) {
    if (!state.activePage) return false;
    state.saving = true;
    state.error = null;
    try {
      const widgets = state.activePage.widgets.filter((widget) => widget.id !== widgetId);
      const res = await appApi.saveDashboardPageLayout(state.activePage.id, widgets);
      if (!res.ok) {
        state.error = res.message;
        return false;
      }
      state.activePage = res.data.page;
      return true;
    } catch (err) {
      state.error = String(err);
      return false;
    } finally {
      state.saving = false;
    }
  }

  function clearPreview() {
    state.preview = null;
  }

  return {
    get loading() { return state.loading; },
    get saving() { return state.saving; },
    get error() { return state.error; },
    get workbookId() { return state.workbookId; },
    get pages() { return state.pages; },
    get activePageId() { return state.activePageId; },
    get activePage() { return state.activePage; },
    get preview() { return state.preview; },
    get views() { return Object.values(state.viewsById); },
    get viewsById() { return state.viewsById; },
    get cachesByViewId() { return state.cachesByViewId; },
    load,
    loadForWorkspace(workspaceId: string, requestedPageId?: string) {
      return load(workspaceId, undefined, requestedPageId, true);
    },
    loadForWorkbook(workspaceId: string, workbookId: string, requestedPageId?: string, ensurePage = false) {
      return load(workspaceId, workbookId, requestedPageId, ensurePage);
    },
    loadPage,
    createPage,
    renamePage,
    previewView,
    createViewAndAttach,
    refreshPage,
    removeWidget,
    clearPreview,
  };
}

export const dashboardsStore = createDashboardsStore();
