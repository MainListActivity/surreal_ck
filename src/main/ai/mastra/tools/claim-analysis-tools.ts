import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { GridColumnDef } from "../../../../shared/rpc.types";
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
  sheetId: z.string().describe("当前数据表 record id，例如 sheet:claims"),
  recordId: z.string().describe("当前选中记录 record id，例如 ent_claim:abc"),
  values: z.record(z.string(), z.unknown()).describe("当前选中记录的字段值"),
  fields: z.array(GridColumnDefSchema).describe("当前数据表字段定义"),
  suggestions: z.array(z.object({
    field: z.string(),
    suggestedValue: z.unknown(),
    basis: z.string(),
    confidence: ConfidenceSchema,
  })).describe("基于当前记录和关联上下文生成的字段补全建议"),
});

export type ClaimRowSuggestion = z.infer<typeof AnalyzeClaimRowInputSchema>["suggestions"][number];

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
    "调用前应先读取用户上下文中的 sheetId、recordId、当前行 values 和字段定义。",
    "只返回需要用户确认的 row-patch-proposal，不直接写入数据库。",
  ].join(" "),
  inputSchema: AnalyzeClaimRowInputSchema,
  outputSchema: RowPatchProposalIntentSchema,
  execute: async (input) => ({
    intent: buildRowPatchProposal(input as z.infer<typeof AnalyzeClaimRowInputSchema>),
  }),
});

const FetchRelatedRecordsOutputSchema = z.object({
  items: z.array(z.unknown()),
});

export const fetchRelatedRecordsTool = createTool({
  id: "fetchRelatedRecords",
  description: "根据当前记录中的 reference 字段读取关联记录预览，为债权行分析提供上下文。",
  inputSchema: z.object({
    values: z.record(z.string(), z.unknown()),
    fields: z.array(GridColumnDefSchema),
  }),
  outputSchema: FetchRelatedRecordsOutputSchema,
  execute: async ({ values, fields }) => {
    const ids = collectReferenceIds(values, fields as GridColumnDef[]);
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
