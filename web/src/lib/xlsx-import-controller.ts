import type { ParsedXlsxImport, ParsedXlsxSheet } from "./xlsx-import";
import type { ImportBatchService, ImportBatchStatus } from "./import-batch";
import { importFingerprint } from "./import-batch";
import type { TemplateImportMapping } from "./template-sheet-import";

export type XlsxSheetAction =
  | { kind: "ignore" }
  | { kind: "new-sheet" }
  | { kind: "map-existing"; targetSheetId: string };

export type XlsxSheetImportResult = {
  sheetName: string;
  status: "success" | "failed" | "ignored" | "outcome-unknown";
  importedCount: number;
  skippedCount: number;
  error: string | null;
  rejected?: Array<{ rowNumber: number; field: string; reason: string; sourceCells?: string[] }>;
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
  batchId: string | null;
  batchStatus: ImportBatchStatus | null;
  batchError: string | null;
};

type NewWorkbookResult = {
  workbookId: string;
  sheets: Array<{
    sheetName: string;
    importedCount: number;
    skippedCount: number;
    rejected?: Array<{ rowNumber: number; field: string; reason: string; sourceCells?: string[] }>;
  }>;
};

type ExistingSheetResult = {
  importedCount: number;
  skippedCount: number;
  rejected?: Array<{ rowNumber: number; field: string; reason: string; sourceCells?: string[] }>;
};

export function createXlsxImportController(input: {
  parsed: ParsedXlsxImport;
  batchService?: ImportBatchService;
  resolveMappings?: (sheet: ParsedXlsxSheet, targetSheetId: string) => TemplateImportMapping[];
  /** 模板实例中的数据表顺序；映射导入按此顺序执行，使引用目标先于引用方落库。 */
  existingTargetOrder?: string[];
  importNewWorkbook: (input: {
    workbookName: string;
    sheets: ParsedXlsxSheet[];
    batch?: { id: string };
  }) => Promise<NewWorkbookResult>;
  importExistingSheet: (input: {
    sheet: ParsedXlsxSheet;
    targetSheetId: string;
    batch?: { id: string; sheetName: string };
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
  let batchId: string | null = null;
  let batchStatus: ImportBatchStatus | null = null;
  let batchError: string | null = null;

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
    batchError = null;
    let receiptUpdateFailed = false;
    const persistSheetResult = async (
      sheetName: string,
      result: Parameters<ImportBatchService["finishSheet"]>[2],
    ): Promise<void> => {
      if (!input.batchService || !batchId) return;
      try {
        await input.batchService.finishSheet(batchId, sheetName, result);
      } catch (cause) {
        receiptUpdateFailed = true;
        batchError = `批次结果待核实：${safeError(cause)}`;
      }
    };
    const resultByName = new Map<string, XlsxSheetImportResult>();
    const newSheets = input.parsed.sheets.filter((sheet) => actions.get(sheet.name)?.kind === "new-sheet");

    if (input.batchService) {
      try {
        const activeActions = [...actions.values()];
        const hasNew = activeActions.some((action) => action.kind === "new-sheet");
        const hasExisting = activeActions.some((action) => action.kind === "map-existing");
        const mappingVersion = importMappingVersion(input.parsed, actions, input.resolveMappings);
        const started = await input.batchService.start({
          fileName: input.parsed.fileName,
          fileDigest: importSourceDigest(input.parsed),
          mappingVersion,
          mode: hasNew && hasExisting ? "mixed" : hasNew ? "new_workbook" : "existing_tables",
          sheets: input.parsed.sheets.map((sheet) => {
            const action = actions.get(sheet.name) ?? { kind: "ignore" };
            return {
              sheetName: sheet.name,
              ...(action.kind === "map-existing" ? { targetSheetId: action.targetSheetId } : {}),
              mappings: action.kind === "map-existing" && input.resolveMappings
                ? input.resolveMappings(sheet, action.targetSheetId)
                : sheet.fields.map((field) => ({
                sourceIndex: field.sourceIndex,
                sourceLabel: field.label,
                targetKey: action.kind === "ignore" ? null : field.key,
                matchedBy: action.kind === "ignore" ? null : "field-name" as const,
              })),
              ignored: action.kind === "ignore",
            };
          }),
        });
        batchId = started.id;
        batchStatus = "processing";
      } catch (cause) {
        batchError = safeError(cause);
        importing = false;
        return;
      }
    }

    if (newSheets.length) {
      try {
        const created = await input.importNewWorkbook({
          workbookName: input.parsed.workbookName,
          sheets: newSheets,
          ...(batchId ? { batch: { id: batchId } } : {}),
        });
        workbookId = created.workbookId;
        for (const sheet of created.sheets) {
          resultByName.set(sheet.sheetName, success(sheet.sheetName, sheet));
          await persistSheetResult(sheet.sheetName, {
            status: "completed",
            importedCount: sheet.importedCount,
            rejectedCount: sheet.skippedCount,
          });
        }
      } catch (cause) {
        const error = safeError(cause);
        let recovered: Awaited<ReturnType<ImportBatchService["load"]>> = null;
        let verificationUnavailable = false;
        if (input.batchService && batchId) {
          try {
            recovered = await input.batchService.load(batchId);
          } catch {
            verificationUnavailable = true;
          }
        }
        const recoveredRows = recovered?.rows.filter((row) =>
          newSheets.some((sheet) => sheet.name === row.sheetName)) ?? [];
        const fullyReceipted = recovered !== null && newSheets.every((sheet) =>
          recoveredRows.filter((row) => row.sheetName === sheet.name).length === sheet.rows.length);
        if (fullyReceipted && recovered) workbookId = recovered.workbookId;

        for (const sheet of newSheets) {
          const sheetRows = recoveredRows.filter((row) => row.sheetName === sheet.name);
          if (fullyReceipted) {
            const rejected = sheetRows
              .filter((row) => row.status !== "success")
              .map((row) => ({
                rowNumber: row.rowNumber,
                field: row.field ?? "整条记录",
                reason: row.reason ?? "导入失败",
                sourceCells: row.sourceCells,
              }));
            const importedCount = sheetRows.filter((row) => row.status === "success").length;
            resultByName.set(sheet.name, success(sheet.name, {
              importedCount,
              skippedCount: rejected.length,
              ...(rejected.length ? { rejected } : {}),
            }));
            await persistSheetResult(sheet.name, {
              status: "completed",
              importedCount,
              rejectedCount: rejected.length,
            });
            continue;
          }

          const outcomeUnknown = verificationUnavailable || recoveredRows.length > 0;
          resultByName.set(sheet.name, outcomeUnknown
            ? outcomeUnknownSheet(sheet, error)
            : failedSheet(sheet, error));
          await persistSheetResult(sheet.name, {
            status: outcomeUnknown ? "outcome_unknown" : "failed",
            importedCount: 0,
            rejectedCount: outcomeUnknown ? 0 : sheet.rows.length,
            error,
          });
        }
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
          ...(batchId ? { batch: { id: batchId, sheetName: sheet.name } } : {}),
        });
        firstImportedTargetId ??= action.targetSheetId;
        resultByName.set(sheet.name, success(sheet.name, imported));
        await persistSheetResult(sheet.name, {
          status: "completed",
          importedCount: imported.importedCount,
          rejectedCount: imported.skippedCount,
          targetSheetId: action.targetSheetId,
        });
      } catch (cause) {
        const error = safeError(cause);
        resultByName.set(sheet.name, failedSheet(sheet, error));
        await persistSheetResult(sheet.name, {
          status: "failed",
          importedCount: 0,
          rejectedCount: sheet.rows.length,
          error,
          targetSheetId: action.targetSheetId,
        });
      }
    }

    results = input.parsed.sheets.map((sheet) => resultByName.get(sheet.name) ?? {
      sheetName: sheet.name,
      status: "ignored",
      importedCount: 0,
      skippedCount: 0,
      error: sheet.issue,
    });
    if (input.batchService && batchId) {
      for (const result of results.filter((item) => item.status === "ignored")) {
        await persistSheetResult(result.sheetName, {
          status: "ignored",
          importedCount: 0,
          rejectedCount: 0,
        });
      }
      batchStatus = receiptUpdateFailed ? "outcome_unknown" : terminalBatchStatus(results);
      try {
        await input.batchService.finish(batchId, batchStatus);
      } catch (cause) {
        batchStatus = "outcome_unknown";
        batchError = `批次结果待核实：${safeError(cause)}`;
      }
    }
    importing = false;
  }

  async function recover(id: string): Promise<void> {
    if (!input.batchService) return;
    const recovered = await input.batchService.load(id);
    if (!recovered) {
      batchError = "未找到导入批次";
      return;
    }
    batchId = recovered.id;
    batchStatus = recovered.status;
    workbookId = recovered.workbookId;
    batchError = null;
    results = recovered.sheets.map((sheet) => {
      const rejectedRows = recovered.rows
        .filter((row) => row.sheetName === sheet.sheetName && row.status !== "success" && row.sourceCells.length > 0)
        .map((row) => ({
          rowNumber: row.rowNumber,
          field: row.field ?? "整条记录",
          reason: row.reason ?? (row.status === "outcome_unknown" ? "结果待核实" : "导入失败"),
          sourceCells: row.sourceCells,
        }));
      return {
        sheetName: sheet.sheetName,
        status: sheet.status === "completed"
          ? "success"
          : sheet.status === "ignored"
            ? "ignored"
            : sheet.status === "outcome_unknown"
                || (recovered.status === "outcome_unknown"
                  && (sheet.status === "pending" || sheet.status === "processing"))
              ? "outcome-unknown"
              : "failed",
        importedCount: sheet.importedCount,
        skippedCount: sheet.rejectedCount,
        error: sheet.error,
        ...(rejectedRows.length ? { rejected: rejectedRows } : {}),
      } as XlsxSheetImportResult;
    });
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
      batchId,
      batchStatus,
      batchError,
    };
  }

  return {
    get snapshot() { return snapshot(); },
    setAction,
    cancel,
    confirm,
    recover,
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

function failedSheet(sheet: ParsedXlsxSheet, error: string): XlsxSheetImportResult {
  return {
    ...failed(sheet.name, error),
    skippedCount: sheet.rows.length,
    rejected: sheet.rows.map((sourceCells, index) => ({
      rowNumber: index + 2,
      field: "整条记录",
      reason: error,
      sourceCells: [...sourceCells],
    })),
  };
}

function outcomeUnknownSheet(sheet: ParsedXlsxSheet, error: string): XlsxSheetImportResult {
  return {
    sheetName: sheet.name,
    status: "outcome-unknown",
    importedCount: 0,
    skippedCount: 0,
    error: `结果待核实：${error}`,
  };
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

function terminalBatchStatus(results: XlsxSheetImportResult[]): Exclude<ImportBatchStatus, "processing"> {
  if (results.some((result) => result.status === "outcome-unknown")) return "outcome_unknown";
  const active = results.filter((result) => result.status !== "ignored");
  const failedCount = active.filter((result) => result.status === "failed").length;
  if (failedCount === 0) return "completed";
  if (failedCount === active.length) return "failed";
  return "partial_failure";
}

function importSourceDigest(parsed: ParsedXlsxImport): string {
  return importFingerprint({
    sheets: parsed.sheets.map((sheet) => ({
      name: sheet.name,
      fields: sheet.fields.map((field) => ({
        sourceIndex: field.sourceIndex,
        label: field.label,
        fieldType: field.fieldType,
      })),
      rows: sheet.rows,
    })),
  });
}

function importMappingVersion(
  parsed: ParsedXlsxImport,
  actions: ReadonlyMap<string, XlsxSheetAction>,
  resolveMappings?: (sheet: ParsedXlsxSheet, targetSheetId: string) => TemplateImportMapping[],
): string {
  return importFingerprint(parsed.sheets.map((sheet) => {
    const action = actions.get(sheet.name);
    return {
      name: sheet.name,
      fields: action?.kind === "map-existing" && resolveMappings
        ? resolveMappings(sheet, action.targetSheetId)
        : sheet.fields.map((field) => ({ sourceIndex: field.sourceIndex, key: field.key, type: field.fieldType })),
      action,
    };
  }));
}
