import type { RecordIdString } from "@surreal-ck/shared/rpc.types";
import {
  createEditorUi,
  type EditorPageKind,
  type EditorUiSnapshot,
  type FieldMenuState,
  type LeaveConfirmState,
  type PanelId,
  type ReferencePanelState,
  type ToolAnchor,
  type ViewId,
} from "./editor-ui";

export type { ViewId, PanelId, EditorPageKind } from "./editor-ui";

/**
 * Reactive mirror of the pure {@link createEditorUi}. 纯逻辑层（editor-ui.test.ts
 * 单测）持有真实状态并 emit 快照，这里镜像进 Svelte 5 runes 供组件响应式消费。
 *
 * setter / 方法都委托给纯逻辑层；纯逻辑层 emit 后回写 runes，单向数据流。
 */
const reactive = $state<EditorUiSnapshot>({
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
  showTemplateImport: false,
  showMenu: false,
  selectedRowId: null,
  clipboardStatus: "支持从 Excel / WPS / Google Sheets 直接复制 TSV 粘贴",
  referencePanel: { open: false, targetId: null },
  leaveConfirm: { open: false, draftCount: 0, confirm: null },
});

const store = createEditorUi({
  onChange(snapshot) {
    reactive.pageKind = snapshot.pageKind;
    reactive.dashboardPageId = snapshot.dashboardPageId;
    reactive.view = snapshot.view;
    reactive.panelOpen = snapshot.panelOpen;
    reactive.panelTab = snapshot.panelTab;
    reactive.activeTool = snapshot.activeTool;
    reactive.activeToolAnchor = snapshot.activeToolAnchor;
    reactive.showAdd = snapshot.showAdd;
    reactive.editingFieldKey = snapshot.editingFieldKey;
    reactive.fieldMenu = snapshot.fieldMenu;
    reactive.showShare = snapshot.showShare;
    reactive.showTemplateImport = snapshot.showTemplateImport;
    reactive.showMenu = snapshot.showMenu;
    reactive.selectedRowId = snapshot.selectedRowId;
    reactive.clipboardStatus = snapshot.clipboardStatus;
    reactive.referencePanel = snapshot.referencePanel;
    reactive.leaveConfirm = snapshot.leaveConfirm;
  },
});

export const editorUi = {
  get pageKind(): EditorPageKind { return reactive.pageKind; },
  set pageKind(v: EditorPageKind) { store.pageKind = v; },
  get dashboardPageId(): RecordIdString | null { return reactive.dashboardPageId; },
  set dashboardPageId(v: RecordIdString | null) { store.dashboardPageId = v; },
  get view(): ViewId { return reactive.view; },
  set view(v: ViewId) { store.view = v; },
  get panelOpen(): boolean { return reactive.panelOpen; },
  set panelOpen(v: boolean) { store.panelOpen = v; },
  get panelTab(): PanelId { return reactive.panelTab; },
  set panelTab(v: PanelId) { store.panelTab = v; },
  get activeTool(): string | null { return reactive.activeTool; },
  set activeTool(v: string | null) { store.activeTool = v; },
  get activeToolAnchor(): ToolAnchor | null { return reactive.activeToolAnchor; },
  set activeToolAnchor(v: ToolAnchor | null) { store.activeToolAnchor = v; },
  get showAdd(): boolean { return reactive.showAdd; },
  set showAdd(v: boolean) { store.showAdd = v; },
  get editingFieldKey(): string | null { return reactive.editingFieldKey; },
  set editingFieldKey(v: string | null) { store.editingFieldKey = v; },
  get fieldMenu(): FieldMenuState { return reactive.fieldMenu; },
  get showShare(): boolean { return reactive.showShare; },
  set showShare(v: boolean) { store.showShare = v; },
  get showTemplateImport(): boolean { return reactive.showTemplateImport; },
  set showTemplateImport(v: boolean) { store.showTemplateImport = v; },
  get showMenu(): boolean { return reactive.showMenu; },
  set showMenu(v: boolean) { store.showMenu = v; },
  get selectedRowId(): RecordIdString | null { return reactive.selectedRowId; },
  set selectedRowId(v: RecordIdString | null) { store.selectedRowId = v; },
  get clipboardStatus(): string { return reactive.clipboardStatus; },
  set clipboardStatus(v: string) { store.clipboardStatus = v; },
  get referencePanel(): ReferencePanelState { return reactive.referencePanel; },
  get leaveConfirm(): LeaveConfirmState { return reactive.leaveConfirm; },

  openPanel: (tab: PanelId) => store.openPanel(tab),
  togglePanel: (tab: PanelId) => store.togglePanel(tab),
  toggleTool: (toolId: string, anchor?: ToolAnchor) => store.toggleTool(toolId, anchor),
  openFieldMenu: (fieldKey: string, x: number, y: number) => store.openFieldMenu(fieldKey, x, y),
  closeFieldMenu: () => store.closeFieldMenu(),
  openFieldEditor: (fieldKey: string) => store.openFieldEditor(fieldKey),
  closeFieldEditor: () => store.closeFieldEditor(),
  closeAllPopups: () => store.closeAllPopups(),
  selectRow: (id: RecordIdString | null) => store.selectRow(id),
  askLeaveConfirm: (draftCount: number, confirm: () => void | Promise<void>) =>
    store.askLeaveConfirm(draftCount, confirm),
  closeLeaveConfirm: () => store.closeLeaveConfirm(),
  openReferencePanel: (targetId: RecordIdString) => store.openReferencePanel(targetId),
  closeReferencePanel: () => store.closeReferencePanel(),
};
