import { RecordId, StringRecordId } from "surrealdb";
import { getLocalDb } from "../db/index";
import { ServiceError } from "./errors";
import type {
  GridColumnDef,
  ListReferenceTargetsResponse,
  RecordIdString,
  ReferenceTargetOption,
  ReferenceTargetPreview,
  ResolveReferencesRequest,
  ResolveReferencesResponse,
  SearchReferenceCandidatesRequest,
  SearchReferenceCandidatesResponse,
} from "../../shared/rpc.types";

const REFERENCE_SYSTEM_TABLES = new Set(["app_user"]);
const REFERENCE_ENTITY_TABLE = /^ent_[a-z0-9_]+$/;
const SAFE_FIELD_KEY = /^[a-z][a-z0-9_]{0,62}$/;

const PREVIEW_FIELD_LIMIT = 5;

function assertReferenceTable(table: string): void {
  if (REFERENCE_SYSTEM_TABLES.has(table)) return;
  if (REFERENCE_ENTITY_TABLE.test(table)) return;
  throw new ServiceError("VALIDATION_ERROR", `非法的引用目标表: ${table}`);
}

function assertSafeFieldKey(key: string): void {
  if (!SAFE_FIELD_KEY.test(key)) {
    throw new ServiceError("VALIDATION_ERROR", `非法的字段标识: ${key}`);
  }
}

type StoredColumnDef = {
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

type SheetMetaRow = {
  id: RecordId;
  workbook: RecordId;
  table_name: string;
  label: string;
  column_defs: StoredColumnDef[];
};

type WorkbookMetaRow = {
  id: RecordId;
  workspace: RecordId;
  name: string;
};

type WorkspaceMetaRow = {
  id: RecordId;
  name: string;
};

type AppUserRow = {
  id: RecordId;
  email?: string;
  name?: string;
  display_name?: string;
  avatar?: string;
  created_at?: Date;
};

type EntityRow = Record<string, unknown> & { id: RecordId };

// ─── resolveReferences ───────────────────────────────────────────────────────

/**
 * 输入一组 RecordId 字符串，返回对应的展示快照。
 * 字段读取依赖 SurrealDB 的 PERMISSIONS：当前用户读不到的记录会自动被忽略。
 */
export async function resolveReferences(
  { ids }: ResolveReferencesRequest,
): Promise<ResolveReferencesResponse> {
  const items: ReferenceTargetPreview[] = [];
  if (!ids?.length) return { items };

  // 按 table 分组 + 去重
  const byTable = new Map<string, Set<string>>();
  for (const id of ids) {
    if (typeof id !== "string" || !id.includes(":")) continue;
    const table = id.slice(0, id.indexOf(":"));
    try {
      assertReferenceTable(table);
    } catch {
      continue;
    }
    if (!byTable.has(table)) byTable.set(table, new Set());
    byTable.get(table)!.add(id);
  }

  const sheetMetaCache = new Map<string, SheetMetaRow | null>();
  const workbookMetaCache = new Map<string, WorkbookMetaRow | null>();
  const workspaceMetaCache = new Map<string, WorkspaceMetaRow | null>();

  for (const [table, idSet] of byTable) {
    if (table === "app_user") {
      const rows = await fetchAppUserRows(Array.from(idSet));
      for (const id of idSet) {
        const row = rows.get(id);
        items.push(row ? appUserRowToPreview(id, row) : missingPreview(id, table));
      }
      continue;
    }

    // ent_* 表：先取 sheet/workbook/workspace 元数据；再取实体行。
    const sheetMeta = await loadSheetMetaByTable(table, sheetMetaCache);
    const workbookMeta = sheetMeta
      ? await loadWorkbookMeta(String(sheetMeta.workbook), workbookMetaCache)
      : null;
    const workspaceMeta = workbookMeta
      ? await loadWorkspaceMeta(String(workbookMeta.workspace), workspaceMetaCache)
      : null;

    const rows = await fetchEntityRows(table, Array.from(idSet));
    for (const id of idSet) {
      const row = rows.get(id);
      if (!row || !sheetMeta) {
        items.push(missingPreview(id, table, {
          workbookId: workbookMeta ? String(workbookMeta.id) : undefined,
          workbookName: workbookMeta?.name,
          sheetId: sheetMeta ? String(sheetMeta.id) : undefined,
          sheetName: sheetMeta?.label,
          workspaceId: workspaceMeta ? String(workspaceMeta.id) : undefined,
          workspaceName: workspaceMeta?.name,
        }));
        continue;
      }
      items.push(entityRowToPreview(id, row, sheetMeta, workbookMeta, workspaceMeta));
    }
  }

  return { items };
}

// ─── listReferenceTargets ────────────────────────────────────────────────────

export async function listReferenceTargets(): Promise<ListReferenceTargetsResponse> {
  const db = getLocalDb();
  const targets: ReferenceTargetOption[] = [];

  // 系统对象：app_user
  targets.push({
    table: "app_user",
    label: "系统：用户",
    displayKeys: [
      { key: "display_name", label: "显示名", fieldType: "text" },
      { key: "name", label: "用户名", fieldType: "text" },
      { key: "email", label: "邮箱", fieldType: "text" },
    ],
  });

  // 用户可见的所有 sheet（PERMISSIONS 已经把 workspace 范围限制好了）。
  const sheetRows = await db.query<[SheetMetaRow[]]>(
    `SELECT id, workbook, table_name, label, column_defs FROM sheet ORDER BY workbook, position`,
  );
  const wsCache = new Map<string, WorkspaceMetaRow | null>();
  const wbCache = new Map<string, WorkbookMetaRow | null>();

  for (const sheet of sheetRows[0] ?? []) {
    const wbMeta = await loadWorkbookMeta(String(sheet.workbook), wbCache);
    if (!wbMeta) continue;
    const wsMeta = await loadWorkspaceMeta(String(wbMeta.workspace), wsCache);
    if (!wsMeta) continue;

    const labelParts = [wsMeta.name, wbMeta.name, sheet.label].filter(Boolean);
    targets.push({
      table: sheet.table_name,
      label: labelParts.join(" / "),
      workspaceId: String(wsMeta.id),
      workspaceName: wsMeta.name,
      workbookId: String(wbMeta.id),
      workbookName: wbMeta.name,
      sheetId: String(sheet.id),
      sheetName: sheet.label,
      displayKeys: (sheet.column_defs ?? []).map((c) => ({
        key: c.key,
        label: c.label,
        fieldType: c.field_type,
      })),
    });
  }

  return { targets };
}

// ─── searchReferenceCandidates ───────────────────────────────────────────────

export async function searchReferenceCandidates(
  { table, query, displayKey, limit }: SearchReferenceCandidatesRequest,
): Promise<SearchReferenceCandidatesResponse> {
  assertReferenceTable(table);
  const trimmed = (query ?? "").trim().toLowerCase();
  const max = Math.max(1, Math.min(limit ?? 30, 100));

  if (table === "app_user") {
    const items = await searchAppUsers(trimmed, max);
    return { items };
  }

  const sheetMeta = await loadSheetMetaByTable(table, new Map());
  const wbMeta = sheetMeta
    ? await loadWorkbookMeta(String(sheetMeta.workbook), new Map())
    : null;
  const wsMeta = wbMeta
    ? await loadWorkspaceMeta(String(wbMeta.workspace), new Map())
    : null;
  if (!sheetMeta) {
    throw new ServiceError("NOT_FOUND", "目标 Sheet 不存在或无权访问");
  }

  const effectiveDisplayKey = displayKey
    ? (assertSafeFieldKey(displayKey), displayKey)
    : pickDefaultDisplayKey(sheetMeta);

  const db = getLocalDb();
  let sql = `SELECT * FROM type::table($t)`;
  const bindings: Record<string, unknown> = { t: table };
  if (trimmed && effectiveDisplayKey) {
    sql += ` WHERE string::contains(string::lowercase(string::concat(${effectiveDisplayKey} ?? '')), $q)`;
    bindings.q = trimmed;
  }
  sql += ` LIMIT ${max}`;

  const rowsResult = await db.query<[EntityRow[]]>(sql, bindings);
  const rows = rowsResult[0] ?? [];

  const items = rows.map((row) =>
    entityRowToPreview(String(row.id), row, sheetMeta, wbMeta, wsMeta, effectiveDisplayKey),
  );
  return { items };
}

// ─── 内部：sheet/workbook/workspace 元数据 ──────────────────────────────────

async function loadSheetMetaByTable(
  table: string,
  cache: Map<string, SheetMetaRow | null>,
): Promise<SheetMetaRow | null> {
  if (cache.has(table)) return cache.get(table) ?? null;
  const db = getLocalDb();
  const rows = await db.query<[SheetMetaRow[]]>(
    `SELECT id, workbook, table_name, label, column_defs FROM sheet WHERE table_name = $t LIMIT 1`,
    { t: table },
  );
  const sheet = rows[0]?.[0] ?? null;
  cache.set(table, sheet);
  return sheet;
}

async function loadWorkbookMeta(
  workbookId: string,
  cache: Map<string, WorkbookMetaRow | null>,
): Promise<WorkbookMetaRow | null> {
  if (cache.has(workbookId)) return cache.get(workbookId) ?? null;
  const db = getLocalDb();
  const rows = await db.query<[WorkbookMetaRow[]]>(
    `SELECT id, workspace, name FROM workbook WHERE id = $wbId LIMIT 1`,
    { wbId: new StringRecordId(workbookId) },
  );
  const wb = rows[0]?.[0] ?? null;
  cache.set(workbookId, wb);
  return wb;
}

async function loadWorkspaceMeta(
  workspaceId: string,
  cache: Map<string, WorkspaceMetaRow | null>,
): Promise<WorkspaceMetaRow | null> {
  if (cache.has(workspaceId)) return cache.get(workspaceId) ?? null;
  const db = getLocalDb();
  const rows = await db.query<[WorkspaceMetaRow[]]>(
    `SELECT id, name FROM workspace WHERE id = $wsId LIMIT 1`,
    { wsId: new StringRecordId(workspaceId) },
  );
  const ws = rows[0]?.[0] ?? null;
  cache.set(workspaceId, ws);
  return ws;
}

// ─── 内部：批量读 RecordId ──────────────────────────────────────────────────

async function fetchAppUserRows(ids: string[]): Promise<Map<string, AppUserRow>> {
  if (!ids.length) return new Map();
  const db = getLocalDb();
  const recordIds = ids.map((id) => new StringRecordId(id));
  const result = await db.query<[AppUserRow[]]>(
    `SELECT id, email, name, display_name, avatar, created_at FROM app_user WHERE id IN $ids`,
    { ids: recordIds },
  );
  const map = new Map<string, AppUserRow>();
  for (const row of result[0] ?? []) map.set(String(row.id), row);
  return map;
}

async function fetchEntityRows(table: string, ids: string[]): Promise<Map<string, EntityRow>> {
  if (!ids.length) return new Map();
  const db = getLocalDb();
  const recordIds = ids.map((id) => new StringRecordId(id));
  const result = await db.query<[EntityRow[]]>(
    `SELECT * FROM type::table($t) WHERE id IN $ids`,
    { t: table, ids: recordIds },
  );
  const map = new Map<string, EntityRow>();
  for (const row of result[0] ?? []) map.set(String(row.id), row);
  return map;
}

async function searchAppUsers(query: string, limit: number): Promise<ReferenceTargetPreview[]> {
  const db = getLocalDb();
  let sql = `SELECT id, email, name, display_name, avatar FROM app_user`;
  const bindings: Record<string, unknown> = {};
  if (query) {
    sql +=
      ` WHERE string::contains(string::lowercase(display_name ?? ''), $q)` +
      ` OR string::contains(string::lowercase(name ?? ''), $q)` +
      ` OR string::contains(string::lowercase(email ?? ''), $q)`;
    bindings.q = query;
  }
  sql += ` LIMIT ${limit}`;
  const rows = await db.query<[AppUserRow[]]>(sql, bindings);
  return (rows[0] ?? []).map((row) => appUserRowToPreview(String(row.id), row));
}

// ─── 内部：行 → preview ─────────────────────────────────────────────────────

function appUserRowToPreview(id: RecordIdString, row: AppUserRow): ReferenceTargetPreview {
  const primaryLabel = row.display_name || row.name || row.email || id;
  const preview: ReferenceTargetPreview["preview"] = [];
  if (row.display_name) preview.push({ key: "display_name", label: "显示名", value: row.display_name });
  if (row.name) preview.push({ key: "name", label: "用户名", value: row.name });
  if (row.email) preview.push({ key: "email", label: "邮箱", value: row.email });
  return {
    id,
    table: "app_user",
    primaryLabel,
    preview,
  };
}

function entityRowToPreview(
  id: RecordIdString,
  row: EntityRow,
  sheet: SheetMetaRow,
  workbook: WorkbookMetaRow | null,
  workspace: WorkspaceMetaRow | null,
  forceDisplayKey?: string,
): ReferenceTargetPreview {
  const displayKey = forceDisplayKey ?? pickDefaultDisplayKey(sheet);
  const primaryLabel = formatPrimaryLabel(row, displayKey, id, workbook?.name, sheet.label);

  const preview: ReferenceTargetPreview["preview"] = [];
  for (const col of sheet.column_defs ?? []) {
    if (preview.length >= PREVIEW_FIELD_LIMIT) break;
    const v = row[col.key];
    if (v === undefined || v === null || v === "") continue;
    preview.push({ key: col.key, label: col.label, value: jsonifyValue(v) });
  }

  return {
    id,
    table: sheet.table_name,
    workspaceId: workspace ? String(workspace.id) : undefined,
    workspaceName: workspace?.name,
    workbookId: workbook ? String(workbook.id) : undefined,
    workbookName: workbook?.name,
    sheetId: String(sheet.id),
    sheetName: sheet.label,
    primaryLabel,
    preview,
  };
}

function missingPreview(
  id: RecordIdString,
  table: string,
  meta: Partial<Pick<ReferenceTargetPreview, "workspaceId" | "workspaceName" | "workbookId" | "workbookName" | "sheetId" | "sheetName">> = {},
): ReferenceTargetPreview {
  return {
    id,
    table,
    ...meta,
    primaryLabel: "已删除的记录",
    missing: true,
    preview: [],
  };
}

function pickDefaultDisplayKey(sheet: SheetMetaRow): string | undefined {
  const keys = (sheet.column_defs ?? []).map((c) => c.key);
  if (keys.includes("name")) return "name";
  return keys[0];
}

function formatPrimaryLabel(
  row: EntityRow,
  displayKey: string | undefined,
  id: RecordIdString,
  workbookName: string | undefined,
  sheetName: string,
): string {
  const raw = displayKey ? row[displayKey] : undefined;
  const value = raw == null || raw === "" ? id : String(jsonifyValue(raw));
  const prefix = workbookName ? `${workbookName} / ${sheetName}` : sheetName;
  return `${prefix} / ${value}`;
}

function jsonifyValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof RecordId) return String(value);
  if (Array.isArray(value)) return value.map(jsonifyValue);
  // SurrealDB 的 DateTime 对象序列化在跨进程边界可能掉精度，这里只走 toISOString 兜底
  if (value && typeof value === "object" && "toISOString" in value && typeof (value as { toISOString: unknown }).toISOString === "function") {
    return (value as { toISOString: () => string }).toISOString();
  }
  return value;
}
