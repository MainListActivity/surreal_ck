import type { SyncChange, SyncOperation } from "./types";

const SYSTEM_FIELDS = new Set(["id", "_origin_session_id", "in", "out"]);

export function assertSafeTableName(table: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(table)) {
    throw new Error(`[sync] unsafe table name: ${table}`);
  }
}

export function showChangesSql(table: string): string {
  assertSafeTableName(table);
  return `SHOW CHANGES FOR TABLE ${table} SINCE $cursor LIMIT 100`;
}

export function normalizeChangefeedRows(table: string, result: unknown): SyncChange[] {
  const rows = firstResultArray(result);
  const changes: SyncChange[] = [];

  for (const row of rows) {
    if (!isRecord(row)) continue;
    const versionstamp = String(row.versionstamp ?? row.vs ?? row.version ?? "");
    if (!versionstamp) continue;

    const nested = Array.isArray(row.changes) ? row.changes : [row];
    for (const item of nested) {
      if (!isRecord(item)) continue;
      const parsed = parseChange(table, versionstamp, item);
      if (parsed) changes.push(parsed);
    }
  }

  return changes;
}

export function extractDirtyContent(change: SyncChange): Record<string, unknown> {
  if (!change.dirtyFields?.length) return stripSystemFields(change.content);

  const content: Record<string, unknown> = {};
  for (const field of change.dirtyFields) {
    if (SYSTEM_FIELDS.has(field)) continue;
    if (Object.prototype.hasOwnProperty.call(change.content, field)) {
      content[field] = change.content[field];
    }
  }
  return content;
}

export function isRemoteEcho(change: SyncChange): boolean {
  return typeof change.content._origin_session_id === "string"
    && change.content._origin_session_id.startsWith("remote:");
}

function parseChange(table: string, versionstamp: string, item: Record<string, unknown>): SyncChange | null {
  const op = parseOperation(item);
  if (!op) return null;

  const content = parseContent(item, op);
  const recordId = parseRecordId(item, content);
  if (!recordId) return null;

  const dirtyFields = Array.isArray(item.dirtyFields)
    ? item.dirtyFields.filter((field): field is string => typeof field === "string")
    : Array.isArray(item.fields)
      ? item.fields.filter((field): field is string => typeof field === "string")
      : undefined;

  return { table, versionstamp, op, recordId, content, dirtyFields };
}

function parseOperation(item: Record<string, unknown>): SyncOperation | null {
  const action = item.action ?? item.op ?? item.operation;
  if (action === "create" || action === "CREATE") return "create";
  if (action === "update" || action === "UPDATE") return "update";
  if (action === "delete" || action === "DELETE") return "delete";
  if ("create" in item) return "create";
  if ("update" in item) return "update";
  if ("delete" in item) return "delete";
  return null;
}

function parseContent(item: Record<string, unknown>, op: SyncOperation): Record<string, unknown> {
  const content =
    item.content ??
    item[op] ??
    item.after ??
    item.record ??
    {};
  return isRecord(content) ? content : {};
}

function parseRecordId(item: Record<string, unknown>, content: Record<string, unknown>): string | null {
  const id = item.recordId ?? item.id ?? content.id;
  return id === undefined || id === null ? null : String(id);
}

function stripSystemFields(row: Record<string, unknown>): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (SYSTEM_FIELDS.has(key)) continue;
    content[key] = value;
  }
  return content;
}

function firstResultArray(result: unknown): unknown[] {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0] as unknown[];
  if (Array.isArray(result)) return result;
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
