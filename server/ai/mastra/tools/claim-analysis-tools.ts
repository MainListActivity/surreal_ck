import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { StringRecordId, type Surreal } from "surrealdb";
import type { GridColumnDef } from "@surreal-ck/shared";
import { getSurrealSession, type ToolRequestContext } from "./tool-session";

const SYSTEM_FIELDS = new Set(["id", "workspace", "created_by", "created_at", "updated_at"]);

/** SurrealDB SDK query() 返回「每条语句结果」数组；取第一条语句行集。 */
function firstStatementRows<T>(queryResult: unknown): T[] {
  if (!Array.isArray(queryResult)) return [];
  const first = queryResult[0];
  return Array.isArray(first) ? (first as T[]) : [];
}

const ConfidenceSchema = z.enum(["high", "medium", "low"]);

const GridColumnDefSchema = z.object({
  key: z.string(),
  label: z.string(),
  fieldType: z.string(),
  required: z.boolean().optional(),
  options: z.array(z.string()).optional(),
  constraints: z.record(z.string(), z.unknown()).optional(),
  dateFormat: z.string().optional(),
  referenceTable: z.string().optional(),
  referenceSheetId: z.string().optional(),
  referenceMultiple: z.boolean().optional(),
  referenceDisplayKey: z.string().optional(),
});

const RowPatchProposalItemSchema = z.object({
  field: z.string(),
  currentValue: z.unknown(),
  suggestedValue: z.unknown(),
  basis: z.string(),
  confidence: ConfidenceSchema,
});

const RowPatchProposalIntentSchema = z.object({
  intent: z.object({
    type: z.literal("row-patch-proposal"),
    sheetId: z.string(),
    recordId: z.string(),
    proposals: z.array(RowPatchProposalItemSchema),
  }),
});

const AnalyzeClaimRowInputSchema = z.object({
  workbookId: z.string().optional().describe("当前工作簿 record id，例如 workbook:demo；当未直接提供 values/fields 时必填"),
  sheetId: z.string().describe("当前数据表 record id，例如 sheet:claims"),
  recordId: z.string().describe("当前选中记录 record id，例如 ent_claim:abc"),
  values: z.record(z.string(), z.unknown()).optional().describe("当前选中记录的字段值；缺省时 tool 通过 workbookId/sheetId/recordId 读取"),
  fields: z.array(GridColumnDefSchema).optional().describe("当前数据表字段定义；缺省时 tool 通过 workbookId/sheetId 读取"),
  suggestions: z.array(z.object({
    field: z.string(),
    suggestedValue: z.unknown(),
    basis: z.string(),
    confidence: ConfidenceSchema,
  })).describe("基于当前记录和关联上下文生成的字段补全建议"),
});

export type ClaimRowSuggestion = z.infer<typeof AnalyzeClaimRowInputSchema>["suggestions"][number];

type ClaimRowContextInput = {
  workbookId?: string;
  sheetId: string;
  recordId: string;
  values?: Record<string, unknown>;
  fields?: GridColumnDef[];
};

/**
 * 读取当前债权行的 values + 字段定义。
 * - 调用方已传 values+fields 时纯返回，不碰 DB；
 * - 否则用调用者 session 读 sheet.column_defs（字段定义）和真实数据表里的当前记录。
 */
export async function resolveClaimRowContext(
  input: ClaimRowContextInput,
  session?: Surreal,
): Promise<{ values: Record<string, unknown>; fields: GridColumnDef[] }> {
  if (input.values && input.fields) {
    return { values: input.values, fields: input.fields };
  }

  if (!session) {
    throw new Error("analyzeClaimRow 需要调用者 session 才能读取当前记录和字段定义");
  }

  const sheetResult = await session.query(
    `SELECT table_name, column_defs FROM $sheet LIMIT 1`,
    { sheet: new StringRecordId(input.sheetId) },
  );
  const sheetRow = firstStatementRows<{ table_name: string; column_defs: GridColumnDef[] }>(sheetResult)[0];
  if (!sheetRow) {
    throw new Error(`找不到数据表定义: ${input.sheetId}`);
  }

  const recordResult = await session.query(`SELECT * FROM $record LIMIT 1`, {
    record: new StringRecordId(input.recordId),
  });
  const row = firstStatementRows<Record<string, unknown>>(recordResult)[0];
  if (!row) {
    throw new Error(`当前数据表中找不到记录: ${input.recordId}`);
  }

  return {
    values: input.values ?? row,
    fields: input.fields ?? sheetRow.column_defs ?? [],
  };
}

/** 用调用者 session 读关联记录预览。 */
async function resolveReferencesViaSession(
  session: Surreal,
  ids: string[],
): Promise<{ items: unknown[] }> {
  if (ids.length === 0) return { items: [] };
  const result = await session.query(`SELECT * FROM $ids`, {
    ids: ids.map((id) => new StringRecordId(id)),
  });
  return { items: firstStatementRows<unknown>(result) };
}

export function buildRowPatchProposal(input: {
  sheetId: string;
  recordId: string;
  values: Record<string, unknown>;
  fields: GridColumnDef[];
  suggestions: ClaimRowSuggestion[];
}): z.infer<typeof RowPatchProposalIntentSchema>["intent"] {
  const editableFields = new Set(
    input.fields
      .filter((field) => isEditableField(field))
      .map((field) => field.key),
  );

  return {
    type: "row-patch-proposal",
    sheetId: input.sheetId,
    recordId: input.recordId,
    proposals: input.suggestions
      .filter((suggestion) => editableFields.has(suggestion.field))
      .map((suggestion) => ({
        field: suggestion.field,
        currentValue: input.values[suggestion.field],
        suggestedValue: suggestion.suggestedValue,
        basis: suggestion.basis,
        confidence: suggestion.confidence,
      })),
  };
}

function isEditableField(field: GridColumnDef): boolean {
  if (!field.key || SYSTEM_FIELDS.has(field.key)) return false;
  return field.fieldType !== "unknown";
}

export const analyzeClaimRowTool = createTool({
  id: "analyzeClaimRow",
  description: [
    "为当前选中债权记录生成字段补全提案。",
    "调用时传入用户上下文中的 workbookId、sheetId、recordId；tool 会通过主进程服务读取当前行 values 和字段定义。",
    "只返回需要用户确认的 row-patch-proposal，不直接写入数据库。",
  ].join(" "),
  inputSchema: AnalyzeClaimRowInputSchema,
  outputSchema: RowPatchProposalIntentSchema,
  execute: async (input, ctx) => {
    const parsed = input as z.infer<typeof AnalyzeClaimRowInputSchema>;
    // values+fields 已齐时不需要 session；否则取调用者 session 读取
    const session = (parsed.values && parsed.fields) ? undefined : getSurrealSession(ctx as ToolRequestContext);
    const context = await resolveClaimRowContext(parsed, session);
    return {
      intent: buildRowPatchProposal({
        sheetId: parsed.sheetId,
        recordId: parsed.recordId,
        values: context.values,
        fields: context.fields,
        suggestions: parsed.suggestions,
      }),
    };
  },
});

const FetchRelatedRecordsOutputSchema = z.object({
  items: z.array(z.unknown()),
});

export const fetchRelatedRecordsTool = createTool({
  id: "fetchRelatedRecords",
  description: "根据当前记录中的 reference 字段读取关联记录预览，为债权行分析提供上下文。",
  inputSchema: z.object({
    workbookId: z.string().optional(),
    sheetId: z.string().optional(),
    recordId: z.string().optional(),
    values: z.record(z.string(), z.unknown()).optional(),
    fields: z.array(GridColumnDefSchema).optional(),
  }),
  outputSchema: FetchRelatedRecordsOutputSchema,
  execute: async ({ workbookId, sheetId, recordId, values, fields }, ctx) => {
    const db = getSurrealSession(ctx as ToolRequestContext);
    const context = sheetId && recordId
      ? await resolveClaimRowContext({
          workbookId,
          sheetId,
          recordId,
          values,
          fields: fields as GridColumnDef[] | undefined,
        }, db)
      : { values: values ?? {}, fields: (fields ?? []) as GridColumnDef[] };
    const ids = collectReferenceIds(context.values, context.fields);
    return resolveReferencesViaSession(db, ids);
  },
});

export function collectReferenceIds(values: Record<string, unknown>, fields: GridColumnDef[]): string[] {
  const ids: string[] = [];
  for (const field of fields) {
    if (field.fieldType !== "reference") continue;
    const value = values[field.key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.includes(":")) ids.push(item);
      }
      continue;
    }
    if (typeof value === "string" && value.includes(":")) ids.push(value);
  }
  return Array.from(new Set(ids));
}

export const CLAIM_ANALYSIS_TOOLS = {
  analyzeClaimRow: analyzeClaimRowTool,
  fetchRelatedRecords: fetchRelatedRecordsTool,
} as const;
