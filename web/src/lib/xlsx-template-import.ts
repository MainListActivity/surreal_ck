import type { ParsedXlsxSheet } from "./xlsx-import";
import {
  mapCsvHeadersToTemplateFields,
  type TemplateImportExecutionInput,
  type TemplateImportExecutionResult,
  type TemplateImportRejectedRow,
  type TemplateImportTarget,
} from "./template-sheet-import";

export async function importXlsxSheetIntoTemplate(input: {
  sheet: ParsedXlsxSheet;
  targets: TemplateImportTarget[];
  importRows: (input: TemplateImportExecutionInput) => Promise<TemplateImportExecutionResult>;
}): Promise<{
  importedCount: number;
  skippedCount: number;
  rejected: TemplateImportRejectedRow[];
}> {
  if (input.sheet.status !== "ready") {
    throw new Error(input.sheet.issue ?? "Sheet 不可导入");
  }
  const mappings = mapCsvHeadersToTemplateFields(
    input.sheet.fields.map((field) => field.label),
    input.targets,
  );
  const result = await input.importRows({ rows: input.sheet.rows, mappings });
  return {
    importedCount: result.importedCount,
    skippedCount: result.rejected.length,
    rejected: result.rejected,
  };
}
