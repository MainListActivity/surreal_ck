import type { RecordIdString } from "@surreal-ck/shared/rpc.types";

export type ViewId = "grid" | "kanban" | "gallery" | "form";
export type PanelId = "detail" | "changes";
export type EditorPageKind = "sheet" | "dashboard";

export type ToolAnchor = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type FieldMenuState = {
  open: boolean;
  fieldKey: string | null;
  x: number;
  y: number;
};

export type ReferencePanelState = {
  open: boolean;
  targetId: RecordIdString | null;
};

export type LeaveConfirmState = {
  open: boolean;
  draftCount: number;
  confirm: (() => void | Promise<void>) | null;
};

export type EditorUiState = {
  pageKind: EditorPageKind;
  dashboardPageId: RecordIdString | null;
  view: ViewId;
  panelOpen: boolean;
  panelTab: PanelId;
  activeTool: string | null;
  activeToolAnchor: ToolAnchor | null;
  showAdd: boolean;
  editingFieldKey: string | null;
  fieldMenu: FieldMenuState;
  showShare: boolean;
  showMenu: boolean;
  selectedRowId: RecordIdString | null;
  clipboardStatus: string;
  /**
   * 引用记录详情侧栏。点击单元格内的引用徽章 / 详情面板里 reference 字段值时打开。
   * 与本工作簿当前选中行无关；展示的是被引用记录的只读快照。
   */
  referencePanel: ReferencePanelState;
  /**
   * 离开工作簿前的草稿确认弹窗。confirm = 用户选择放弃 draft 后真正要执行的导航/动作。
   */
  leaveConfirm: LeaveConfirmState;
};

/** runes 层镜像的快照（与 state 同形；纯 UI 态无派生视图）。 */
export type EditorUiSnapshot = EditorUiState;

export type EditorUiDeps = {
  /** 镜像进 runes，使组件响应式更新。纯逻辑层不依赖它。 */
  onChange?: (snapshot: EditorUiSnapshot) => void;
};

export type EditorUi = ReturnType<typeof createEditorUi>;

const DEFAULT_CLIPBOARD_STATUS = "支持从 Excel / WPS / Google Sheets 直接复制 TSV 粘贴";

/**
 * 编辑器纯 UI 状态（哪个视图/面板/工具打开、选中行、字段菜单、离开确认等）。
 *
 * 几乎不碰数据层——保持与 legacy `editor-ui.svelte.ts` 同样的方法面，组件迁移只需
 * 改 import 路径。runes 镜像在 editor-ui.svelte.ts；这里是可单测的纯逻辑工厂。
 */
export function createEditorUi(deps: EditorUiDeps = {}) {
  const state: EditorUiState = {
    pageKind: "sheet",
    dashboardPageId: null,
    view: "grid",
    panelOpen: false,
    panelTab: "detail",
    activeTool: null,
    activeToolAnchor: null,
    showAdd: false,
    editingFieldKey: null,
    fieldMenu: { open: false, fieldKey: null, x: 0, y: 0 },
    showShare: false,
    showMenu: false,
    selectedRowId: null,
    clipboardStatus: DEFAULT_CLIPBOARD_STATUS,
    referencePanel: { open: false, targetId: null },
    leaveConfirm: { open: false, draftCount: 0, confirm: null },
  };

  function emit(): void {
    deps.onChange?.({
      ...state,
      fieldMenu: { ...state.fieldMenu },
      referencePanel: { ...state.referencePanel },
      leaveConfirm: { ...state.leaveConfirm },
    });
  }

  return {
    get pageKind(): EditorPageKind { return state.pageKind; },
    set pageKind(v: EditorPageKind) { state.pageKind = v; emit(); },
    get dashboardPageId(): RecordIdString | null { return state.dashboardPageId; },
    set dashboardPageId(v: RecordIdString | null) { state.dashboardPageId = v; emit(); },
    get view(): ViewId { return state.view; },
    set view(v: ViewId) { state.view = v; emit(); },
    get panelOpen(): boolean { return state.panelOpen; },
    set panelOpen(v: boolean) { state.panelOpen = v; emit(); },
    get panelTab(): PanelId { return state.panelTab; },
    set panelTab(v: PanelId) { state.panelTab = v; emit(); },
    get activeTool(): string | null { return state.activeTool; },
    set activeTool(v: string | null) { state.activeTool = v; emit(); },
    get activeToolAnchor(): ToolAnchor | null { return state.activeToolAnchor; },
    set activeToolAnchor(v: ToolAnchor | null) { state.activeToolAnchor = v; emit(); },
    get showAdd(): boolean { return state.showAdd; },
    set showAdd(v: boolean) { state.showAdd = v; emit(); },
    get editingFieldKey(): string | null { return state.editingFieldKey; },
    set editingFieldKey(v: string | null) { state.editingFieldKey = v; emit(); },
    get fieldMenu(): FieldMenuState { return state.fieldMenu; },
    get showShare(): boolean { return state.showShare; },
    set showShare(v: boolean) { state.showShare = v; emit(); },
    get showMenu(): boolean { return state.showMenu; },
    set showMenu(v: boolean) { state.showMenu = v; emit(); },
    get selectedRowId(): RecordIdString | null { return state.selectedRowId; },
    set selectedRowId(v: RecordIdString | null) { state.selectedRowId = v; emit(); },
    get clipboardStatus(): string { return state.clipboardStatus; },
    set clipboardStatus(v: string) { state.clipboardStatus = v; emit(); },
    get referencePanel(): ReferencePanelState { return state.referencePanel; },
    get leaveConfirm(): LeaveConfirmState { return state.leaveConfirm; },

    openPanel(tab: PanelId): void {
      state.panelTab = tab;
      state.panelOpen = true;
      emit();
    },
    togglePanel(tab: PanelId): void {
      if (state.panelOpen && state.panelTab === tab) {
        state.panelOpen = false;
        emit();
      } else {
        this.openPanel(tab);
      }
    },
    toggleTool(toolId: string, anchor?: ToolAnchor): void {
      if (state.activeTool === toolId) {
        state.activeTool = null;
        state.activeToolAnchor = null;
        emit();
        return;
      }
      state.activeTool = toolId;
      state.activeToolAnchor = anchor ?? null;
      emit();
    },
    openFieldMenu(fieldKey: string, x: number, y: number): void {
      state.fieldMenu = { open: true, fieldKey, x, y };
      emit();
    },
    closeFieldMenu(): void {
      state.fieldMenu = { open: false, fieldKey: null, x: 0, y: 0 };
      emit();
    },
    openFieldEditor(fieldKey: string): void {
      state.editingFieldKey = fieldKey;
      state.fieldMenu = { open: false, fieldKey: null, x: 0, y: 0 };
      emit();
    },
    closeFieldEditor(): void {
      state.editingFieldKey = null;
      emit();
    },
    closeAllPopups(): void {
      state.showMenu = false;
      state.activeTool = null;
      state.activeToolAnchor = null;
      state.fieldMenu = { open: false, fieldKey: null, x: 0, y: 0 };
      emit();
    },
    selectRow(id: RecordIdString | null): void {
      state.selectedRowId = id;
      emit();
    },
    askLeaveConfirm(draftCount: number, confirm: () => void | Promise<void>): void {
      state.leaveConfirm = { open: true, draftCount, confirm };
      emit();
    },
    closeLeaveConfirm(): void {
      state.leaveConfirm = { open: false, draftCount: 0, confirm: null };
      emit();
    },
    openReferencePanel(targetId: RecordIdString): void {
      state.referencePanel = { open: true, targetId };
      emit();
    },
    closeReferencePanel(): void {
      state.referencePanel = { open: false, targetId: null };
      emit();
    },
  };
}
