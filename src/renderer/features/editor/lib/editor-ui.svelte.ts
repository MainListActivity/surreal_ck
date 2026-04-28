import type { RecordIdString } from "../../../../shared/rpc.types";

export type ViewId = "grid" | "kanban" | "gallery";
export type PanelId = "detail" | "changes" | "ai";

type EditorUiState = {
  view: ViewId;
  panelOpen: boolean;
  panelTab: PanelId;
  activeTool: string | null;
  showAdd: boolean;
  showFields: boolean;
  showShare: boolean;
  showMenu: boolean;
  selectedRowId: RecordIdString | null;
  clipboardStatus: string;
};

function createEditorUi() {
  let state = $state<EditorUiState>({
    view: "grid",
    panelOpen: false,
    panelTab: "detail",
    activeTool: null,
    showAdd: false,
    showFields: false,
    showShare: false,
    showMenu: false,
    selectedRowId: null,
    clipboardStatus: "支持从 Excel / WPS / Google Sheets 直接复制 TSV 粘贴",
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
    get showFields() { return state.showFields; },
    set showFields(v) { state.showFields = v; },
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
    closeAllPopups() {
      state.showMenu = false;
      state.activeTool = null;
    },
    selectRow(id: RecordIdString | null) {
      state.selectedRowId = id;
    },
  };
}

export const editorUi = createEditorUi();
