import { getSurreal } from "../../../lib/surreal";
import type { DashboardPage, DashboardPageSummary, DashboardWidget } from "../../../lib/dashboard-data";
import type { SaveResult } from "../../../lib/workbook-data";
import {
  createDashboardStore,
  type DashboardStoreSnapshot,
  type DashboardWidgetData,
} from "./dashboard-store";

/**
 * Reactive mirror of the pure {@link createDashboardStore}（与 editor-store.svelte.ts
 * 同构）：纯逻辑层持真实状态并 emit 快照，这里转发进 runes 让组件响应式更新。
 * 组件只 import `dashboardStore`，不直接碰数据层。
 */
const reactive = $state<DashboardStoreSnapshot>({
  loading: false,
  saving: false,
  error: null,
  workbookId: null,
  pages: [],
  activePageId: null,
  activePage: null,
  widgetData: {},
});

const store = createDashboardStore({
  getConn: getSurreal,
  onChange(snapshot) {
    reactive.loading = snapshot.loading;
    reactive.saving = snapshot.saving;
    reactive.error = snapshot.error;
    reactive.workbookId = snapshot.workbookId;
    reactive.pages = snapshot.pages;
    reactive.activePageId = snapshot.activePageId;
    reactive.activePage = snapshot.activePage;
    reactive.widgetData = snapshot.widgetData;
  },
});

export const dashboardStore = {
  get loading(): boolean { return reactive.loading; },
  get saving(): boolean { return reactive.saving; },
  get error(): string | null { return reactive.error; },
  get pages(): DashboardPageSummary[] { return reactive.pages; },
  get activePageId(): string | null { return reactive.activePageId; },
  get activePage(): DashboardPage | null { return reactive.activePage; },
  get widgetData(): Record<string, DashboardWidgetData> { return reactive.widgetData; },

  open: (scope: { workbookId?: string }, requestedPageId?: string) => store.open(scope, requestedPageId),
  selectPage: (pageId: string) => store.selectPage(pageId),
  refresh: () => store.refresh(),
  createPage: (title: string): Promise<SaveResult> => store.createPage(title),
  renamePage: (pageId: string, title: string): Promise<SaveResult> => store.renamePage(pageId, title),
  deletePage: (pageId: string): Promise<SaveResult> => store.deletePage(pageId),
  upsertWidget: (widget: DashboardWidget): Promise<SaveResult> => store.upsertWidget(widget),
  removeWidget: (widgetId: string): Promise<SaveResult> => store.removeWidget(widgetId),
};
