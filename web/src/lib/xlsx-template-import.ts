import type { ParsedXlsxSheet } from "./xlsx-import";
import {
  mapCsvHeadersToTemplateFields,
  type TemplateImportExecutionInput,
  type TemplateImportExecutionResult,
  type TemplateImportRejectedRow,
  type TemplateImportTarget,
} from "./template-sheet-import";

export type XlsxTemplateTarget = {
  id: string;
  targets: TemplateImportTarget[];
};

/**
 * 用字段名/别名匹配数建议目标数据表。只有唯一最高且至少命中一列时才自动选择，
 * 避免相似结构之间产生武断映射；用户仍可在向导中覆盖建议。
 */
export function suggestXlsxSheetTarget(
  sheet: ParsedXlsxSheet,
  candidates: XlsxTemplateTarget[],
): string | null {
  if (sheet.status !== "ready") return null;
  const headers = sheet.fields.map((field) => field.label);
  const scored = candidates.map((candidate) => ({
    id: candidate.id,
    score: mapCsvHeadersToTemplateFields(headers, candidate.targets)
      .filter((mapping) => mapping.targetKey !== null).length,
  })).sort((left, right) => right.score - left.score);
  const best = scored[0];
  if (!best || best.score === 0 || scored[1]?.score === best.score) return null;
  return best.id;
}

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
