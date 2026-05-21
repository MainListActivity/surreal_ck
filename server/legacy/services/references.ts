import { RecordId, StringRecordId } from "surrealdb";
import { getLocalDb } from "../db/index";
import { ServiceError } from "./errors";
import { DataTableRuntime } from "./data-table-runtime";
import type {
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

  const runtimeCache = new Map<string, DataTableRuntime | null>();

  for (const [table, idSet] of byTable) {
    if (table === "app_user") {
      const rows = await fetchAppUserRows(Array.from(idSet));
      for (const id of idSet) {
        const row = rows.get(id);
        items.push(row ? appUserRowToPreview(id, row) : missingPreview(id, table));
      }
      continue;
    }

    let runtime = runtimeCache.get(table);
    if (runtime === undefined) {
      runtime = await DataTableRuntime.loadByTableName(table);
      runtimeCache.set(table, runtime);
    }

    const rows = await fetchEntityRows(table, Array.from(idSet));
    for (const id of idSet) {
      const row = rows.get(id);
      if (!row || !runtime) {
        items.push(missingPreview(id, table, runtime ? {
          workbookId: runtime.context.workbookId,
          workbookName: runtime.context.workbookName,
          sheetId: String(runtime.sheet.id),
          sheetName: runtime.sheet.label,
          workspaceId: runtime.context.workspaceId,
          workspaceName: runtime.context.workspaceName,
        } : {}));
        continue;
      }
      items.push(runtime.buildEntityPreview(id, row));
    }
  }

  return { items };
}

// ─── listReferenceTargets ────────────────────────────────────────────────────

export async function listReferenceTargets(): Promise<ListReferenceTargetsResponse> {
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

  const items = await DataTableRuntime.listAllForReference();
  for (const item of items) {
    if (!item.workspaceName) continue;
    const labelParts = [item.workspaceName, item.workbookName, item.sheetLabel].filter(Boolean);
    targets.push({
      table: item.runtime.tableName,
      label: labelParts.join(" / "),
      workspaceId: item.workspaceId,
      workspaceName: item.workspaceName,
      workbookId: item.workbookId,
      workbookName: item.workbookName,
      sheetId: item.sheetId,
      sheetName: item.sheetLabel,
      displayKeys: item.runtime.sheet.column_defs.map((c) => ({
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

  const runtime = await DataTableRuntime.loadByTableName(table);
  if (!runtime) {
    throw new ServiceError("NOT_FOUND", "目标 Sheet 不存在或无权访问");
  }

  const effectiveDisplayKey = displayKey
    ? (assertSafeFieldKey(displayKey), displayKey)
    : runtime.sheet.column_defs.find((c) => c.key === "name")?.key
      ?? runtime.sheet.column_defs[0]?.key;

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
    runtime.buildEntityPreview(String(row.id), row, effectiveDisplayKey ? { forceDisplayKey: effectiveDisplayKey } : undefined),
  );
  return { items };
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
