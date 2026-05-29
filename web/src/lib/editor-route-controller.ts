import type { Route } from "./route";

export type EditorRouteControllerDeps = {
  loadWorkbook: (workbookId: string, sheetId?: string) => void | Promise<void>;
  switchSheet: (sheetId: string) => void | Promise<void>;
  resetEditor: () => void;
  enterSheetPage: () => void;
};

export function createEditorRouteController(deps: EditorRouteControllerDeps) {
  let currentWorkbookId: string | null = null;
  let currentSheetId: string | null = null;

  return {
    async open(route: Route): Promise<void> {
      if (route.kind !== "editor") {
        deps.resetEditor();
        currentWorkbookId = null;
        currentSheetId = null;
        return;
      }

      deps.enterSheetPage();
      if (
        currentWorkbookId === route.workbookId
        && route.sheetId
        && route.sheetId !== currentSheetId
      ) {
        currentSheetId = route.sheetId;
        await deps.switchSheet(route.sheetId);
        return;
      }

      currentWorkbookId = route.workbookId;
      currentSheetId = route.sheetId;
      await deps.loadWorkbook(route.workbookId, route.sheetId ?? undefined);
    },
  };
}
