import type { RecordIdString } from "../../../../shared/rpc.types";

export type ViewId = "grid" | "kanban" | "gallery" | "form";
export type PanelId = "detail" | "changes" | "ai";
export type EditorPageKind = "sheet" | "dashboard";

type EditorUiState = {
  pageKind: EditorPageKind;
  dashboardPageId: RecordIdString | null;
  view: ViewId;
  panelOpen: boolean;
  panelTab: PanelId;
  activeTool: string | null;
  activeToolAnchor: {
    left: number;
    top: number;
    width: number;
    height: number;
  } | null;
  showAdd: boolean;
  editingFieldKey: string | null;
  fieldMenu: {
    open: boolean;
    fieldKey: string | null;
    x: number;
    y: number;
  };
  showShare: boolean;
  showMenu: boolean;
  selectedRowId: RecordIdString | null;
  clipboardStatus: string;
  /**
   * 引用记录详情侧栏。点击单元格内的引用徽章 / 详情面板里 reference 字段值时打开。
   * 与本工作簿当前选中行无关；展示的是被引用记录的只读快照。
   */
  referencePanel: {
    open: boolean;
    targetId: RecordIdString | null;
  };
  /**
   * 离开工作簿前的草稿确认弹窗。confirm = 用户选择放弃 draft 后真正要执行的导航/动作。
   */
  leaveConfirm: {
    open: boolean;
    draftCount: number;
    confirm: (() => void | Promise<void>) | null;
  };
};

function createEditorUi() {
  let state = $state<EditorUiState>({
    pageKind: "sheet",
    dashboardPageId: null,
    view: "grid",
    panelOpen: false,
    panelTab: "detail",
    activeTool: null,
    activeToolAnchor: null,
    showAdd: false,
    editingFieldKey: null,
    fieldMenu: {
      open: false,
      fieldKey: null,
      x: 0,
      y: 0,
    },
    showShare: false,
    showMenu: false,
    selectedRowId: null,
    clipboardStatus: "支持从 Excel / WPS / Google Sheets 直接复制 TSV 粘贴",
    referencePanel: { open: false, targetId: null },
    leaveConfirm: { open: false, draftCount: 0, confirm: null },
  });

  return {
    get pageKind() { return state.pageKind; },
    set pageKind(v) { state.pageKind = v; },
    get dashboardPageId() { return state.dashboardPageId; },
    set dashboardPageId(v) { state.dashboardPageId = v; },
    get view() { return state.view; },
    set view(v) { state.view = v; },
    get panelOpen() { return state.panelOpen; },
    set panelOpen(v) { state.panelOpen = v; },
    get panelTab() { return state.panelTab; },
    set panelTab(v) { state.panelTab = v; },
    get activeTool() { return state.activeTool; },
    set activeTool(v) { state.activeTool = v; },
    get activeToolAnchor() { return state.activeToolAnchor; },
    set activeToolAnchor(v) { state.activeToolAnchor = v; },
    get showAdd() { return state.showAdd; },
    set showAdd(v) { state.showAdd = v; },
    get editingFieldKey() { return state.editingFieldKey; },
    set editingFieldKey(v) { state.editingFieldKey = v; },
    get fieldMenu() { return state.fieldMenu; },
    get showShare() { return state.showShare; },
    set showShare(v) { state.showShare = v; },
    get showMenu() { return state.showMenu; },
    set showMenu(v) { state.showMenu = v; },
    get selectedRowId() { return state.selectedRowId; },
    set selectedRowId(v) { state.selectedRowId = v; },
    get clipboardStatus() { return state.clipboardStatus; },
    set clipboardStatus(v) { state.clipboardStatus = v; },

    openPanel(tab: PanelId) {
      state.panelTab = tab;
      state.panelOpen = true;
    },
    togglePanel(tab: PanelId) {
      if (state.panelOpen && state.panelTab === tab) {
        state.panelOpen = false;
      } else {
        this.openPanel(tab);
      }
    },
    toggleTool(toolId: string, anchor?: { left: number; top: number; width: number; height: number }) {
      if (state.activeTool === toolId) {
        state.activeTool = null;
        state.activeToolAnchor = null;
        return;
      }
      state.activeTool = toolId;
      state.activeToolAnchor = anchor ?? null;
    },
    openFieldMenu(fieldKey: string, x: number, y: number) {
      state.fieldMenu = { open: true, fieldKey, x, y };
    },
    closeFieldMenu() {
      state.fieldMenu = { open: false, fieldKey: null, x: 0, y: 0 };
    },
    openFieldEditor(fieldKey: string) {
      state.editingFieldKey = fieldKey;
      this.closeFieldMenu();
    },
    closeFieldEditor() {
      state.editingFieldKey = null;
    },
    closeAllPopups() {
      state.showMenu = false;
      state.activeTool = null;
      state.activeToolAnchor = null;
      this.closeFieldMenu();
    },
    selectRow(id: RecordIdString | null) {
      state.selectedRowId = id;
    },
    get leaveConfirm() { return state.leaveConfirm; },
    askLeaveConfirm(draftCount: number, confirm: () => void | Promise<void>) {
      state.leaveConfirm = { open: true, draftCount, confirm };
    },
    closeLeaveConfirm() {
      state.leaveConfirm = { open: false, draftCount: 0, confirm: null };
    },
    get referencePanel() { return state.referencePanel; },
    openReferencePanel(targetId: RecordIdString) {
      state.referencePanel = { open: true, targetId };
    },
    closeReferencePanel() {
      state.referencePanel = { open: false, targetId: null };
    },
  };
}

export const editorUi = createEditorUi();
