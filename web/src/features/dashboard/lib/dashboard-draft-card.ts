import type { DashboardDraftIntent, DashboardPreviewResponse } from "@surreal-ck/shared";
import {
  createDashboardPage,
  listDashboardPages,
  loadDashboardPage,
  saveDashboardPageWidgets,
  type DashboardWidget,
} from "../../../lib/dashboard-data";
import { runDashboardWidgetQuery } from "../../../lib/dashboard-query";
import type { SurrealConn } from "../../../lib/surreal";
import { newWidgetId, nextGridPlacement } from "./dashboard-builder";

/**
 * AI 仪表盘草稿卡（D3-05）的纯逻辑层：预览 → 确认 → 直连持久化。
 *
 * Router workflow 在写操作前 suspend，`dashboard-draft` 意图经 chat stream 推到
 * AI 抽屉；本模块负责草稿到 widget / 预览查询 / `dashboard_page` 写入 payload 的
 * 转换与卡片状态流转。widget 形态与手工 builder（dashboard-builder.ts）完全同口径，
 * 不存在 AI 专用的第二套 widget 描述。
 */

/** 草稿意图 → 内嵌进 `dashboard_page.widgets[]` 的 widget；落位沿用 builder 的两列流式布局。 */
export function widgetFromDashboardDraft(
  intent: DashboardDraftIntent,
  existingWidgets: DashboardWidget[],
): DashboardWidget {
  return {
    id: newWidgetId(),
    title: intent.title,
    viewType: intent.draft.viewType,
    spec: intent.widgetSpec,
    grid: nextGridPlacement(existingWidgets.length, intent.draft.viewType),
  };
}

/**
 * 真实数据预览：把草稿的 widget 配置交给 D3-02 编译器，以当前会话直连执行
 * 编译出的参数化聚合 SELECT——只读，不含任何写语句；失败上抛由卡片转入预览错误态。
 */
export function previewDashboardDraft(
  conn: SurrealConn,
  intent: DashboardDraftIntent,
): Promise<DashboardPreviewResponse> {
  return runDashboardWidgetQuery(conn, {
    spec: intent.widgetSpec,
    viewType: intent.draft.viewType,
    display: intent.draft.displaySpec,
  });
}

export type PersistDashboardDraftResult =
  | { ok: true; pageId: string; pageTitle: string; widgetId: string; createdPage: boolean }
  | { ok: false; message: string };

/**
 * 确认保存：以当前会话直连写 `dashboard_page`。作用域（草稿携带的 workbook，
 * 没有则 workspace 级）内已有页时向最近更新的页追加 widget；没有页时先以草稿
 * 标题新建页再写入。widget 经 {@link widgetFromDashboardDraft} 落成与手工 builder
 * 完全同口径的形态，编辑/删除/刷新行为一致。写权限由表 PERMISSIONS 兜底，
 * 拒绝时由 D3-01 数据层翻译成中文错误返回。
 */
export async function persistDashboardDraft(
  conn: SurrealConn,
  intent: DashboardDraftIntent,
): Promise<PersistDashboardDraftResult> {
  const scope = intent.draft.workbookId ? { workbookId: intent.draft.workbookId } : {};
  let pages;
  try {
    pages = await listDashboardPages(conn, scope);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  if (pages.length === 0) {
    const created = await createDashboardPage(conn, {
      title: intent.title,
      ...(intent.draft.workbookId ? { workbookId: intent.draft.workbookId } : {}),
      ...(intent.draft.description ? { description: intent.draft.description } : {}),
    });
    if (!created.ok) return created;
    return appendWidget(conn, created.page.id, created.page.title, created.page.widgets, intent, true);
  }

  const target = pages[0];
  let page;
  try {
    page = await loadDashboardPage(conn, target.id);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  if (!page) return { ok: false, message: "目标仪表盘页不存在或不可见，请刷新后重试。" };
  return appendWidget(conn, page.id, page.title, page.widgets, intent, false);
}

async function appendWidget(
  conn: SurrealConn,
  pageId: string,
  pageTitle: string,
  existingWidgets: DashboardWidget[],
  intent: DashboardDraftIntent,
  createdPage: boolean,
): Promise<PersistDashboardDraftResult> {
  const widget = widgetFromDashboardDraft(intent, existingWidgets);
  const saved = await saveDashboardPageWidgets(conn, pageId, [...existingWidgets, widget]);
  if (!saved.ok) return saved;
  return { ok: true, pageId, pageTitle, widgetId: widget.id, createdPage };
}

export type DashboardDraftCardState = {
  status: "previewing" | "ready" | "preview-error" | "saving" | "rejecting" | "done" | "rejected" | "error";
  preview: DashboardPreviewResponse | null;
  saved: { pageId: string; pageTitle: string; createdPage: boolean } | null;
  error: string | null;
};

export type DashboardDraftCardDeps = {
  intent: DashboardDraftIntent;
  /** 真实数据预览（生产接 {@link previewDashboardDraft}，当前会话只读直连）。 */
  preview: () => Promise<DashboardPreviewResponse>;
  /** 确认保存（生产接 {@link persistDashboardDraft}，当前会话直连写 dashboard_page）。 */
  save: () => Promise<PersistDashboardDraftResult>;
  /** resume workflow run（生产接 ai-drawer session 的 resumeWrite）。 */
  resume: (decision: { kind: "write-confirmed" | "write-rejected" }) => Promise<void>;
  onChange?: (state: DashboardDraftCardState) => void;
};

export type DashboardDraftCard = ReturnType<typeof createDashboardDraftCard>;

/**
 * 草稿卡状态机：previewing → ready（或 preview-error）→ 确认保存 / 忽略 → resume。
 * 与 svelte runes 镜像分离（沿用 row-patch-card 的分层风格）。
 * 保存成功才以 write-confirmed resume；预览失败只能忽略，不提供保存入口。
 */
export function createDashboardDraftCard(deps: DashboardDraftCardDeps) {
  const state: DashboardDraftCardState = {
    status: "previewing",
    preview: null,
    saved: null,
    error: null,
  };

  function cloneState(): DashboardDraftCardState {
    return { ...state, saved: state.saved ? { ...state.saved } : null };
  }

  function emitChange(): void {
    deps.onChange?.(cloneState());
  }

  async function loadPreview(): Promise<void> {
    if (state.status !== "previewing") return;
    try {
      state.preview = await deps.preview();
      state.status = "ready";
      state.error = null;
    } catch (err) {
      state.status = "preview-error";
      state.error = err instanceof Error ? err.message : String(err);
    }
    emitChange();
  }

  /** resume 失败时回到 error 态保留卡片（confirm 重试时 save 会再写一次，widget 整组覆盖幂等）。 */
  async function resumeTo(
    decision: { kind: "write-confirmed" | "write-rejected" },
    doneStatus: "done" | "rejected",
  ): Promise<void> {
    try {
      await deps.resume(decision);
    } catch (err) {
      state.status = "error";
      state.error = err instanceof Error ? err.message : String(err);
      emitChange();
      return;
    }
    state.status = doneStatus;
    emitChange();
  }

  /** 确认保存：仅 ready / error（保存或 resume 失败重试）可进；预览失败没有保存入口。 */
  async function confirm(): Promise<void> {
    if (state.status !== "ready" && state.status !== "error") return;
    state.status = "saving";
    state.error = null;
    emitChange();

    const result = await deps.save();
    if (!result.ok) {
      state.status = "error";
      state.error = result.message;
      emitChange();
      return;
    }
    state.saved = { pageId: result.pageId, pageTitle: result.pageTitle, createdPage: result.createdPage };
    await resumeTo({ kind: "write-confirmed" }, "done");
  }

  /** 忽略草稿：以 write-rejected resume，run 走取消路径，不产生任何 dashboard 记录。 */
  async function reject(): Promise<void> {
    if (state.status !== "ready" && state.status !== "preview-error" && state.status !== "error") return;
    state.status = "rejecting";
    state.error = null;
    emitChange();

    await resumeTo({ kind: "write-rejected" }, "rejected");
  }

  return {
    snapshot: cloneState,
    loadPreview,
    confirm,
    reject,
  };
}
