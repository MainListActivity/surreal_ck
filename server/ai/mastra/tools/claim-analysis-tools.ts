import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { GridColumnDef } from "../../../../shared/rpc.types";
import { getWorkbookData } from "../../../services/editor";
import { resolveReferences } from "../../../services/references";

const SYSTEM_FIELDS = new Set(["id", "workspace", "created_by", "created_at", "updated_at"]);

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

export async function resolveClaimRowContext(input: ClaimRowContextInput): Promise<{
  values: Record<string, unknown>;
  fields: GridColumnDef[];
}> {
  if (input.values && input.fields) {
    return { values: input.values, fields: input.fields };
  }

  if (!input.workbookId) {
    throw new Error("analyzeClaimRow 需要 workbookId 才能读取当前记录和字段定义");
  }

  const data = await getWorkbookData({ workbookId: input.workbookId, sheetId: input.sheetId });
  const row = data.rows.find((item) => item.id === input.recordId);
  if (!row) {
    throw new Error(`当前数据表中找不到记录: ${input.recordId}`);
  }

  return {
    values: row.values,
    fields: data.columns,
  };
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
  execute: async (input) => {
    const parsed = input as z.infer<typeof AnalyzeClaimRowInputSchema>;
    const context = await resolveClaimRowContext(parsed);
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
  execute: async ({ workbookId, sheetId, recordId, values, fields }) => {
    const context = sheetId && recordId
      ? await resolveClaimRowContext({
          workbookId,
          sheetId,
          recordId,
          values,
          fields: fields as GridColumnDef[] | undefined,
        })
      : { values: values ?? {}, fields: (fields ?? []) as GridColumnDef[] };
    const ids = collectReferenceIds(context.values, context.fields);
    return resolveReferences({ ids });
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
