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

export function buildAiContextSnapshot(input: BuildAiContextSnapshotInput): AiContextSnapshot {
  const workbook = input.workbook ?? null;
  const sheet = input.sheet ?? null;
  const selectedRow = buildSelectedRowContext(input);

  return {
    route: input.route,
    workbook,
    sheet,
    selectedRow,
    contextHint: buildContextHint(input.route, workbook, sheet, selectedRow),
  };
}

export type AiContextForAi = Omit<AiContextSnapshot, "contextHint" | "workbook" | "sheet" | "selectedRow"> & {
  workbook?: NonNullable<AiWorkbookContext>;
  sheet?: NonNullable<AiSheetContext>;
  selectedRow?: NonNullable<AiSelectedRowContext>;
};

export function serializeContextForAi(snapshot: AiContextSnapshot): AiContextForAi {
  const result: AiContextForAi = { route: snapshot.route };
  if (snapshot.workbook) result.workbook = snapshot.workbook;
  if (snapshot.sheet) result.sheet = snapshot.sheet;
  if (snapshot.selectedRow) result.selectedRow = snapshot.selectedRow;
  return result;
}

export function createAiUserMessage(input: CreateAiUserMessageInput): AiChatMessage | null {
  const content = input.prompt.trim();
  if (!content) return null;
  return {
    id: input.id ?? crypto.randomUUID(),
    role: "user",
    content,
    createdAt: input.createdAt ?? new Date().toISOString(),
    context: cloneSnapshotValue(input.context) as AiContextSnapshot,
  };
}

function buildSelectedRowContext(input: BuildAiContextSnapshotInput): AiSelectedRowContext {
  if (!input.selectedRowId) return null;
  const row = input.rows?.find((item) => item.id === input.selectedRowId);
  if (!row) return null;

  const visibleValues = pickVisibleValues(row, input.visibleColumns ?? []);
  return {
    id: row.id,
    label: buildSelectedRowLabel(row, visibleValues),
    visibleValues,
  };
}

function pickVisibleValues(row: GridRow, visibleColumns: GridColumnDef[]): Record<string, unknown> {
  if (!visibleColumns.length) return { ...row.values };
  const values: Record<string, unknown> = {};
  for (const column of visibleColumns) {
    if (Object.prototype.hasOwnProperty.call(row.values, column.key)) {
      values[column.key] = cloneSnapshotValue(row.values[column.key]);
    }
  }
  return values;
}

function cloneSnapshotValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function buildSelectedRowLabel(row: GridRow, visibleValues: Record<string, unknown>): string {
  const primary = findStableValue(visibleValues, [/display/i, /name/i, /姓名|名称|申报人|债权人/]);
  const secondary = findStableValue(visibleValues, [/code/i, /number/i, /no$/i, /编号|编码|单号/]);
  return [primary, secondary, row.id].filter(Boolean).join(" || ");
}

function findStableValue(values: Record<string, unknown>, patterns: RegExp[]): string | null {
  for (const [key, value] of Object.entries(values)) {
    if (!patterns.some((pattern) => pattern.test(key))) continue;
    const label = stringifyLabelValue(value);
    if (label) return label;
  }
  return null;
}

function stringifyLabelValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  return null;
}

function buildContextHint(
  route: AiRouteContext,
  workbook: AiWorkbookContext,
  sheet: AiSheetContext,
  selectedRow: AiSelectedRowContext,
): string {
  if (sheet && selectedRow) return `${sheet.label} / ${selectedRow.label}`;
  if (workbook && sheet) return `${workbook.name} / ${sheet.label}`;
  return labelForRoute(route);
}

function labelForRoute(route: AiRouteContext): string {
  if (route.screen === "dashboard") return "当前在仪表盘";
  if (route.screen === "editor") return "当前在表格工作簿";
  if (route.screen === "mydocs") return "当前在我的文档";
  if (route.screen === "settings") return "当前在设置";
  if (route.screen === "templates") return "当前在模板中心";
  return "当前在应用首页";
}
