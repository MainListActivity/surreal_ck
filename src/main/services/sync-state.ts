import { getLocalDb, getRemoteDb } from "../db/index";
import { discardDeadLetter, forceReapplyDeadLetter, listDeadLetters as listDeadLettersFromDb } from "../sync/dead-letter";
import { getLocalSessionId } from "../sync/session";
import { getSyncRuntimeState } from "../sync/status";
import { getOfflineMode } from "./offline-state";
import type {
  ListDeadLettersRequest,
  ListDeadLettersResponse,
  SyncDeadLetterDTO,
  SyncStatusDTO,
} from "../../shared/rpc.types";

type CountRow = { count?: number };
type CursorRow = { updated_at?: string | Date };

export async function getSyncStatus(): Promise<SyncStatusDTO> {
  const db = getLocalDb();
  const [pendingCount, deadLetterCount, lastLocalCursorAt, lastRemoteCursorAt] = await Promise.all([
    countPendingChanges(db).catch(() => 0),
    countDeadLetters(db).catch(() => 0),
    readLastCursorAt(db, "local_to_remote").catch(() => undefined),
    readLastCursorAt(db, "remote_to_local").catch(() => undefined),
  ]);
  const runtime = getSyncRuntimeState();

  return {
    online: !getOfflineMode() && getRemoteDb() !== null && !runtime.incompatibleSchema,
    sessionId: getLocalSessionId(),
    pendingCount,
    deadLetterCount,
    lastLocalCursorAt,
    lastRemoteCursorAt,
    incompatibleSchema: runtime.incompatibleSchema,
    localChangefeedStale: runtime.localChangefeedStale,
    ...(runtime.lastError ? { lastError: runtime.lastError } : {}),
  };
}

export async function listDeadLetters(req: ListDeadLettersRequest = {}): Promise<ListDeadLettersResponse> {
  const rows = await listDeadLettersFromDb(getLocalDb(), req);
  return { items: rows.map(deadLetterToDTO) };
}

export async function discardSyncDeadLetter(id: string): Promise<void> {
  await discardDeadLetter(getLocalDb(), id);
}

export async function forceReapplySyncDeadLetter(id: string): Promise<void> {
  const remote = getRemoteDb();
  if (!remote) throw new Error("[sync] remote db is not connected");
  await forceReapplyDeadLetter(getLocalDb(), remote, id);
}

async function countPendingChanges(db: { query<T = unknown>(sql: string, bindings?: Record<string, unknown>): Promise<T> }): Promise<number> {
  const rows = await db.query<[CountRow[]]>(
    `SELECT count() AS count FROM sync_cursor WHERE direction = 'local_to_remote'`,
  );
  return Number(rows[0]?.[0]?.count ?? 0);
}

async function countDeadLetters(db: { query<T = unknown>(sql: string, bindings?: Record<string, unknown>): Promise<T> }): Promise<number> {
  const rows = await db.query<[CountRow[]]>(
    `SELECT count() AS count FROM sync_dead_letter`,
  );
  return Number(rows[0]?.[0]?.count ?? 0);
}

async function readLastCursorAt(
  db: { query<T = unknown>(sql: string, bindings?: Record<string, unknown>): Promise<T> },
  direction: "local_to_remote" | "remote_to_local",
): Promise<string | undefined> {
  const rows = await db.query<[CursorRow[]]>(
    `SELECT updated_at FROM sync_cursor WHERE direction = $direction ORDER BY updated_at DESC LIMIT 1`,
    { direction },
  );
  const value = rows[0]?.[0]?.updated_at;
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : String(value);
}

function deadLetterToDTO(row: {
  id: string;
  target_table: string;
  target_id: string;
  versionstamp: string;
  op: string;
  error_message: string;
  created_at?: unknown;
}): SyncDeadLetterDTO {
  return {
    id: String(row.id),
    targetTable: row.target_table,
    targetId: row.target_id,
    versionstamp: row.versionstamp,
    op: row.op,
    errorMessage: row.error_message,
    ...(row.created_at ? { createdAt: String(row.created_at) } : {}),
  };
}
