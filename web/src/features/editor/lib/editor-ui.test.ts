import { describe, expect, test } from "bun:test";
import { createEditorUi, type EditorUiSnapshot } from "./editor-ui";

function setup() {
  const snapshots: EditorUiSnapshot[] = [];
  const ui = createEditorUi({ onChange: (s) => snapshots.push(s) });
  return { ui, snapshots };
}

describe("初始状态", () => {
  test("默认 sheet 页、grid 视图、面板关闭、无选中行", () => {
    const { ui } = setup();
    expect(ui.pageKind).toBe("sheet");
    expect(ui.view).toBe("grid");
    expect(ui.panelOpen).toBe(false);
    expect(ui.panelTab).toBe("detail");
    expect(ui.activeTool).toBeNull();
    expect(ui.selectedRowId).toBeNull();
    expect(ui.referencePanel).toEqual({ open: false, targetId: null });
    expect(ui.leaveConfirm).toEqual({ open: false, draftCount: 0, confirm: null });
  });
});

describe("面板 open/toggle", () => {
  test("openPanel 设置 tab 并打开", () => {
    const { ui } = setup();
    ui.openPanel("changes");
    expect(ui.panelOpen).toBe(true);
    expect(ui.panelTab).toBe("changes");
  });

  test("togglePanel 同 tab 二次调用关闭，不同 tab 切换并保持打开", () => {
    const { ui } = setup();
    ui.togglePanel("changes");
    expect(ui.panelOpen).toBe(true);
    expect(ui.panelTab).toBe("changes");
    ui.togglePanel("changes");
    expect(ui.panelOpen).toBe(false);
    ui.togglePanel("detail");
    expect(ui.panelOpen).toBe(true);
    expect(ui.panelTab).toBe("detail");
  });
});

describe("工具栏 toggleTool", () => {
  test("打开记录 anchor，再次点同一 tool 关闭并清 anchor", () => {
    const { ui } = setup();
    const anchor = { left: 1, top: 2, width: 3, height: 4 };
    ui.toggleTool("filter", anchor);
    expect(ui.activeTool).toBe("filter");
    expect(ui.activeToolAnchor).toEqual(anchor);
    ui.toggleTool("filter");
    expect(ui.activeTool).toBeNull();
    expect(ui.activeToolAnchor).toBeNull();
  });

  test("切到另一 tool 替换 active", () => {
    const { ui } = setup();
    ui.toggleTool("filter");
    ui.toggleTool("sort");
    expect(ui.activeTool).toBe("sort");
  });
});

describe("字段菜单 / 字段编辑器", () => {
  test("openFieldMenu 记录坐标，openFieldEditor 关菜单并记编辑字段", () => {
    const { ui } = setup();
    ui.openFieldMenu("amount", 10, 20);
    expect(ui.fieldMenu).toEqual({ open: true, fieldKey: "amount", x: 10, y: 20 });
    ui.openFieldEditor("amount");
    expect(ui.editingFieldKey).toBe("amount");
    expect(ui.fieldMenu.open).toBe(false);
    ui.closeFieldEditor();
    expect(ui.editingFieldKey).toBeNull();
  });
});

describe("closeAllPopups", () => {
  test("关闭菜单 / tool / 字段菜单", () => {
    const { ui } = setup();
    ui.showMenu = true;
    ui.toggleTool("filter");
    ui.openFieldMenu("k", 1, 1);
    ui.closeAllPopups();
    expect(ui.showMenu).toBe(false);
    expect(ui.activeTool).toBeNull();
    expect(ui.activeToolAnchor).toBeNull();
    expect(ui.fieldMenu.open).toBe(false);
  });
});

describe("选中行 / 引用面板 / 离开确认", () => {
  test("selectRow 记录 id", () => {
    const { ui } = setup();
    ui.selectRow("ent_claim:a");
    expect(ui.selectedRowId).toBe("ent_claim:a");
    ui.selectRow(null);
    expect(ui.selectedRowId).toBeNull();
  });

  test("open/closeReferencePanel", () => {
    const { ui } = setup();
    ui.openReferencePanel("ent_party:p1");
    expect(ui.referencePanel).toEqual({ open: true, targetId: "ent_party:p1" });
    ui.closeReferencePanel();
    expect(ui.referencePanel).toEqual({ open: false, targetId: null });
  });

  test("askLeaveConfirm 暂存 confirm 回调，close 清空", () => {
    const { ui } = setup();
    const fn = () => {};
    ui.askLeaveConfirm(3, fn);
    expect(ui.leaveConfirm.open).toBe(true);
    expect(ui.leaveConfirm.draftCount).toBe(3);
    expect(ui.leaveConfirm.confirm).toBe(fn);
    ui.closeLeaveConfirm();
    expect(ui.leaveConfirm).toEqual({ open: false, draftCount: 0, confirm: null });
  });
});

describe("onChange — 每次状态变更都发快照", () => {
  test("setter / 方法触发快照", () => {
    const { ui, snapshots } = setup();
    const before = snapshots.length;
    ui.view = "kanban";
    ui.openPanel("changes");
    expect(snapshots.length).toBeGreaterThan(before);
    expect(snapshots[snapshots.length - 1].panelTab).toBe("changes");
    expect(snapshots[snapshots.length - 1].view).toBe("kanban");
  });
});
