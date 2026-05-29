import { describe, expect, test } from "bun:test";
import type { Route } from "./route";
import { createEditorRouteController } from "./editor-route-controller";

describe("editor route controller", () => {
  test("打开工作簿路由时加载对应 workbook 和默认 sheet", async () => {
    const calls: string[] = [];
    const controller = createEditorRouteController({
      loadWorkbook: async (workbookId, sheetId) => {
        calls.push(`load:${workbookId}:${sheetId ?? "default"}`);
      },
      switchSheet: async (sheetId) => {
        calls.push(`switch:${sheetId}`);
      },
      resetEditor: () => {
        calls.push("reset");
      },
      enterSheetPage: () => {
        calls.push("sheet-page");
      },
    });

    await controller.open(editorRoute("workbook:wb1"));

    expect(calls).toEqual(["sheet-page", "load:workbook:wb1:default"]);
  });

  test("同一 workbook 切换 sheet 路由时只切 sheet，不重载 workbook", async () => {
    const calls: string[] = [];
    const controller = createEditorRouteController({
      loadWorkbook: async (workbookId, sheetId) => {
        calls.push(`load:${workbookId}:${sheetId ?? "default"}`);
      },
      switchSheet: async (sheetId) => {
        calls.push(`switch:${sheetId}`);
      },
      resetEditor: () => {
        calls.push("reset");
      },
      enterSheetPage: () => {
        calls.push("sheet-page");
      },
    });

    await controller.open(editorRoute("workbook:wb1"));
    await controller.open(editorRoute("workbook:wb1", "sheet:s2"));

    expect(calls).toEqual([
      "sheet-page",
      "load:workbook:wb1:default",
      "sheet-page",
      "switch:sheet:s2",
    ]);
  });
});

function editorRoute(workbookId: string, sheetId: string | null = null): Route {
  return {
    kind: "editor",
    slug: "acme",
    workbookId,
    sheetId,
  };
}
