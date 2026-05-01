import type { RecordIdString } from "../../../../shared/rpc.types";

export type ViewId = "grid" | "kanban" | "gallery" | "form";
export type PanelId = "detail" | "changes" | "ai";

type EditorUiState = {
  view: ViewId;
  panelOpen: boolean;
  panelTab: PanelId;
  activeTool: string | null;
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
    view: "grid",
    panelOpen: false,
    panelTab: "detail",
    activeTool: null,
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
    leaveConfirm: { open: false, draftCount: 0, confirm: null },
  });

  return {
    get view() { return state.view; },
    set view(v) { state.view = v; },
    get panelOpen() { return state.panelOpen; },
    set panelOpen(v) { state.panelOpen = v; },
    get panelTab() { return state.panelTab; },
    set panelTab(v) { state.panelTab = v; },
    get activeTool() { return state.activeTool; },
    set activeTool(v) { state.activeTool = v; },
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
    toggleTool(toolId: string) {
      state.activeTool = state.activeTool === toolId ? null : toolId;
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
  };
}

export const editorUi = createEditorUi();
