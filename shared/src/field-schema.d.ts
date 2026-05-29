import type { GridColumnDef, GridFieldConstraints } from "./rpc.types";
export declare const GRID_FIELD_TYPE_OPTIONS: readonly [{
    readonly value: "text";
    readonly label: "文本";
    readonly icon: "textType";
}, {
    readonly value: "single_select";
    readonly label: "单选";
    readonly icon: "list";
}, {
    readonly value: "number";
    readonly label: "数字";
    readonly icon: "hash";
}, {
    readonly value: "decimal";
    readonly label: "金额/小数";
    readonly icon: "coins";
}, {
    readonly value: "date";
    readonly label: "日期";
    readonly icon: "calendar";
}, {
    readonly value: "checkbox";
    readonly label: "勾选";
    readonly icon: "checkSquare";
}, {
    readonly value: "reference";
    readonly label: "引用";
    readonly icon: "link";
}];
export type GridFieldType = typeof GRID_FIELD_TYPE_OPTIONS[number]["value"];
export type GridFieldDraft = GridColumnDef & {
    optionsText?: string;
    constraints: GridFieldConstraints;
};
export type StoredGridFieldDef = {
    key: string;
    label: string;
    field_type: string;
    required?: boolean;
    options?: string[];
    constraints?: GridColumnDef["constraints"];
    date_format?: string;
    reference_table?: string;
    reference_sheet_id?: string;
    reference_multiple?: boolean;
    reference_display_key?: string;
};
export type SurrealFieldSchema = {
    fieldName: string;
    type: string;
    assert: string;
};
export declare function buildGridFieldDraft(column: GridColumnDef): GridFieldDraft;
export declare function commitGridFieldDraft(field: GridFieldDraft, strict?: boolean): GridColumnDef;
export declare function normalizeGridColumnDef(column: GridColumnDef): GridColumnDef;
export declare function gridColumnToStoredDef(column: GridColumnDef): StoredGridFieldDef;
export declare function storedColumnToDTO(column: StoredGridFieldDef): GridColumnDef;
export declare function buildSurrealFieldSchema(column: GridColumnDef): SurrealFieldSchema;
export declare function normalizeGridFieldConstraints(fieldType: string, constraints?: GridFieldConstraints): GridFieldConstraints | undefined;
export declare function isRecordIdString(value: unknown): value is string;
/** 校验 RecordId 字符串属于指定目标表（app_user 或 ent_xxx）。 */
export declare function recordIdBelongsToTable(value: unknown, table: string): boolean;
export declare function coerceGridFieldValue(value: unknown, column?: GridColumnDef): unknown;
export declare function validateGridFieldValue(value: unknown, column: GridColumnDef): string[];
export declare function summarizeGridField(column: GridColumnDef): string[];
export declare function normalizeDateInputValue(value: unknown): string;
export declare function normalizeReferenceTable(value: unknown): string;
export declare function normalizeDateFormat(format: string | undefined | null): string | undefined;
