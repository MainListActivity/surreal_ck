import type { ParsedXlsxImport, ParsedXlsxSheet } from "./xlsx-import";

export type XlsxSheetAction =
  | { kind: "ignore" }
  | { kind: "new-sheet" }
  | { kind: "map-existing"; targetSheetId: string };

export type XlsxSheetImportResult = {
  sheetName: string;
  status: "success" | "failed" | "ignored";
  importedCount: number;
  skippedCount: number;
  error: string | null;
  rejected?: Array<{ rowNumber: number; field: string; reason: string }>;
};

export type XlsxImportSummary = {
  importedCount: number;
  skippedCount: number;
  successfulSheetCount: number;
  failedSheetCount: number;
  ignoredSheetCount: number;
};

export type XlsxImportControllerSnapshot = {
  actions: Array<{ sheetName: string; action: XlsxSheetAction }>;
  results: XlsxSheetImportResult[];
  summary: XlsxImportSummary;
  importing: boolean;
  cancelled: boolean;
  workbookId: string | null;
  firstImportedTargetId: string | null;
};

type NewWorkbookResult = {
  workbookId: string;
  sheets: Array<{ sheetName: string; importedCount: number; skippedCount: number }>;
};

type ExistingSheetResult = {
  importedCount: number;
  skippedCount: number;
  rejected?: Array<{ rowNumber: number; field: string; reason: string }>;
};

export function createXlsxImportController(input: {
  parsed: ParsedXlsxImport;
  /** 模板实例中的数据表顺序；映射导入按此顺序执行，使引用目标先于引用方落库。 */
  existingTargetOrder?: string[];
  importNewWorkbook: (input: {
    workbookName: string;
    sheets: ParsedXlsxSheet[];
  }) => Promise<NewWorkbookResult>;
  importExistingSheet: (input: {
    sheet: ParsedXlsxSheet;
    targetSheetId: string;
  }) => Promise<ExistingSheetResult>;
}) {
  const actions = new Map<string, XlsxSheetAction>(input.parsed.sheets.map((sheet) => [
    sheet.name,
    sheet.status === "ready" ? { kind: "new-sheet" } : { kind: "ignore" },
  ]));
  let results: XlsxSheetImportResult[] = [];
  let importing = false;
  let cancelled = false;
  let workbookId: string | null = null;
  let firstImportedTargetId: string | null = null;

  function setAction(sheetName: string, action: XlsxSheetAction): void {
    if (importing || cancelled) return;
    const sheet = input.parsed.sheets.find((candidate) => candidate.name === sheetName);
    if (!sheet || (sheet.status !== "ready" && action.kind !== "ignore")) return;
    actions.set(sheetName, action);
  }

  function cancel(): void {
    if (!importing) cancelled = true;
  }

  async function confirm(): Promise<void> {
    if (importing || cancelled || results.length) return;
    importing = true;
    const resultByName = new Map<string, XlsxSheetImportResult>();
    const newSheets = input.parsed.sheets.filter((sheet) => actions.get(sheet.name)?.kind === "new-sheet");

    if (newSheets.length) {
      try {
        const created = await input.importNewWorkbook({
          workbookName: input.parsed.workbookName,
          sheets: newSheets,
        });
        workbookId = created.workbookId;
        for (const sheet of created.sheets) {
          resultByName.set(sheet.sheetName, success(sheet.sheetName, sheet));
        }
      } catch (cause) {
        const error = safeError(cause);
        for (const sheet of newSheets) resultByName.set(sheet.name, failed(sheet.name, error));
      }
    }

    const targetOrder = new Map(
      (input.existingTargetOrder ?? []).map((targetId, index) => [targetId, index]),
    );
    const mappedSheets = input.parsed.sheets
      .filter((sheet) => actions.get(sheet.name)?.kind === "map-existing")
      .sort((left, right) => {
        const leftAction = actions.get(left.name);
        const rightAction = actions.get(right.name);
        const leftIndex = leftAction?.kind === "map-existing"
          ? (targetOrder.get(leftAction.targetSheetId) ?? Number.MAX_SAFE_INTEGER)
          : Number.MAX_SAFE_INTEGER;
        const rightIndex = rightAction?.kind === "map-existing"
          ? (targetOrder.get(rightAction.targetSheetId) ?? Number.MAX_SAFE_INTEGER)
          : Number.MAX_SAFE_INTEGER;
        return leftIndex - rightIndex;
      });
    for (const sheet of mappedSheets) {
      const action = actions.get(sheet.name);
      if (action?.kind !== "map-existing") continue;
      try {
        const imported = await input.importExistingSheet({
          sheet,
          targetSheetId: action.targetSheetId,
        });
        firstImportedTargetId ??= action.targetSheetId;
        resultByName.set(sheet.name, success(sheet.name, imported));
      } catch (cause) {
        resultByName.set(sheet.name, failed(sheet.name, safeError(cause)));
      }
    }

    results = input.parsed.sheets.map((sheet) => resultByName.get(sheet.name) ?? {
      sheetName: sheet.name,
      status: "ignored",
      importedCount: 0,
      skippedCount: 0,
      error: sheet.issue,
    });
    importing = false;
  }

  function snapshot(): XlsxImportControllerSnapshot {
    return {
      actions: input.parsed.sheets.map((sheet) => ({
        sheetName: sheet.name,
        action: { ...(actions.get(sheet.name) ?? { kind: "ignore" }) } as XlsxSheetAction,
      })),
      results: results.map((result) => ({ ...result })),
      summary: summarize(results),
      importing,
      cancelled,
      workbookId,
      firstImportedTargetId,
    };
  }

  return {
    get snapshot() { return snapshot(); },
    setAction,
    cancel,
    confirm,
  };
}

function success(
  sheetName: string,
  result: {
    importedCount: number;
    skippedCount: number;
    rejected?: Array<{ rowNumber: number; field: string; reason: string }>;
  },
): XlsxSheetImportResult {
  return { sheetName, status: "success", ...result, error: null };
}

function failed(sheetName: string, error: string): XlsxSheetImportResult {
  return { sheetName, status: "failed", importedCount: 0, skippedCount: 0, error };
}

function safeError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.split(/\r?\n/u, 1)[0]?.trim() || "导入失败，请重试";
}

function summarize(results: XlsxSheetImportResult[]): XlsxImportSummary {
  return results.reduce<XlsxImportSummary>((summary, result) => {
    summary.importedCount += result.importedCount;
    summary.skippedCount += result.skippedCount;
    if (result.status === "success") summary.successfulSheetCount += 1;
    else if (result.status === "failed") summary.failedSheetCount += 1;
    else summary.ignoredSheetCount += 1;
    return summary;
  }, {
    importedCount: 0,
    skippedCount: 0,
    successfulSheetCount: 0,
    failedSheetCount: 0,
    ignoredSheetCount: 0,
  });
}
