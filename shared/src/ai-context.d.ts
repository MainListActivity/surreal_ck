import type { GridColumnDef, GridRow, RecordIdString, ResourceCitationDTO } from "./rpc.types";
export type AiRouteContext = {
    screen: string;
    dashboardPageId?: string;
    workbookId?: string;
    sheetId?: string;
    folderId?: string;
    templateKey?: string;
};
export type AiWorkbookContext = {
    id: RecordIdString;
    name: string;
} | null;
export type AiSheetContext = {
    id: RecordIdString;
    label: string;
    tableName: string;
} | null;
export type AiSelectedRowContext = {
    id: RecordIdString;
    label: string;
    visibleValues: Record<string, unknown>;
} | null;
export type AiContextSnapshot = {
    route: AiRouteContext;
    workbook: AiWorkbookContext;
    sheet: AiSheetContext;
    selectedRow: AiSelectedRowContext;
    contextHint: string;
};
export type AiChatMessage = {
    id: string;
    role: "user" | "assistant";
    content: string;
    createdAt: string;
    context: AiContextSnapshot;
    citations?: ResourceCitationDTO[];
};
export type CreateAiUserMessageInput = {
    prompt: string;
    context: AiContextSnapshot;
    id?: string;
    createdAt?: string;
};
export type BuildAiContextSnapshotInput = {
    route: AiRouteContext;
    workbook?: NonNullable<AiWorkbookContext> | null;
    sheet?: NonNullable<AiSheetContext> | null;
    selectedRowId?: RecordIdString | null;
    rows?: GridRow[];
    visibleColumns?: GridColumnDef[];
};
export declare function buildAiContextSnapshot(input: BuildAiContextSnapshotInput): AiContextSnapshot;
export type AiContextForAi = Omit<AiContextSnapshot, "contextHint" | "workbook" | "sheet" | "selectedRow"> & {
    workbook?: NonNullable<AiWorkbookContext>;
    sheet?: NonNullable<AiSheetContext>;
    selectedRow?: NonNullable<AiSelectedRowContext>;
};
export declare function serializeContextForAi(snapshot: AiContextSnapshot): AiContextForAi;
export declare function createAiUserMessage(input: CreateAiUserMessageInput): AiChatMessage | null;
