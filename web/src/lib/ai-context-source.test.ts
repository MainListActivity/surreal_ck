import { describe, expect, test } from "bun:test";
import type { GridColumnDef, GridRow, RecordIdString } from "@surreal-ck/shared/rpc.types";
import { buildDrawerContextSnapshot, type DrawerEditorState } from "./ai-context-source";

function editorState(over: Partial<DrawerEditorState> = {}): DrawerEditorState {
  const columns: GridColumnDef[] = [
    { key: "customer_name", label: "客户名称", fieldType: "text" },
    { key: "amount", label: "金额", fieldType: "decimal" },
  ];
  const rows: GridRow[] = [
    { id: "ent_customer:abc" as RecordIdString, values: { customer_name: "张三", amount: 100 } },
  ];
  return {
    workbook: { id: "workbook:wb1" as RecordIdString, name: "项目台账" },
    sheets: [
      { id: "sheet:s1" as RecordIdString, label: "客户表", tableName: "ent_customer", columns },
    ],
    activeSheetId: "sheet:s1" as RecordIdString,
    rows,
    visibleColumns: columns,
    selectedRowId: null,
    ...over,
  };
}

describe("buildDrawerContextSnapshot", () => {
  test("非 editor 路由：只携带路由与 workspaceSlug，即使传入编辑器状态也不带进快照", () => {
    const snapshot = buildDrawerContextSnapshot({
      workspaceSlug: "acme",
      routeScreen: "dashboard",
      editor: editorState({ selectedRowId: "ent_customer:abc" as RecordIdString }),
    });

    expect(snapshot.workspaceSlug).toBe("acme");
    expect(snapshot.route.screen).toBe("dashboard");
    expect(snapshot.workbook).toBeNull();
    expect(snapshot.sheet).toBeNull();
    expect(snapshot.selectedRow).toBeNull();
  });

  test("editor 路由 + 选中行：快照含 workbook/sheet/记录 id 与可见值，route 带 workbookId/sheetId", () => {
    const snapshot = buildDrawerContextSnapshot({
      workspaceSlug: "acme",
      routeScreen: "editor",
      editor: editorState({ selectedRowId: "ent_customer:abc" as RecordIdString }),
    });

    expect(snapshot.route).toEqual({ screen: "editor", workbookId: "workbook:wb1", sheetId: "sheet:s1" });
    expect(snapshot.workbook).toEqual({ id: "workbook:wb1", name: "项目台账" });
    expect(snapshot.sheet).toEqual({ id: "sheet:s1", label: "客户表", tableName: "ent_customer" });
    expect(snapshot.selectedRow).toEqual({
      id: "ent_customer:abc",
      label: "张三 || ent_customer:abc",
      visibleValues: { customer_name: "张三", amount: 100 },
    });
    expect(snapshot.contextHint).toBe("客户表 / 张三 || ent_customer:abc");
  });

  test("editor 路由 + 未选行：提示为「工作簿 / Sheet」", () => {
    const snapshot = buildDrawerContextSnapshot({
      workspaceSlug: "acme",
      routeScreen: "editor",
      editor: editorState(),
    });

    expect(snapshot.selectedRow).toBeNull();
    expect(snapshot.contextHint).toBe("项目台账 / 客户表");
  });

  test("陈旧 selectedRowId（不在当前行集）：selectedRow 清空，不发送陈旧记录", () => {
    const snapshot = buildDrawerContextSnapshot({
      workspaceSlug: "acme",
      routeScreen: "editor",
      editor: editorState({ selectedRowId: "ent_other:gone" as RecordIdString }),
    });

    expect(snapshot.selectedRow).toBeNull();
    expect(snapshot.contextHint).toBe("项目台账 / 客户表");
  });
});
