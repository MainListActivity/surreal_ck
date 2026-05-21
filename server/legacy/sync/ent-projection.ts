import { StringRecordId } from "surrealdb";
import { markDirtyProjectionData } from "./status";
import { assertSafeTableName } from "./table-name";
import type { LiveMessage, LiveSource, SyncDb } from "./types";

export type RebuildEntProjectionsOptions = {
  localDb: SyncDb;
  remoteDb: SyncDb;
};

type SheetMeta = {
  table_name: string;
  column_defs: Array<Record<string, unknown>>;
};

const REBUILD_ORIGIN = "remote:projection-rebuild";
const ENT_TABLE = /^ent_[a-z0-9_]+$/;

let unsubscribers = new Map<string, () => void>();

export async function rebuildEntProjections(
  options: RebuildEntProjectionsOptions,
): Promise<{ tables: Array<{ table: string; rows: number }> }> {
  const sheets = await loadSheetMeta(options.localDb);
  const tables: Array<{ table: string; rows: number }> = [];
  for (const sheet of sheets) {
    const table = sheet.table_name;
    if (!ENT_TABLE.test(table)) continue;
    assertSafeTableName(table);
    const rows = await fetchRemoteRows(options.remoteDb, table);
    await clearLocalTable(options.localDb, table);
    for (const row of rows) {
      const recordId = row.id;
      if (recordId === undefined || recordId === null) continue;
      await upsertLocalRow(options.localDb, String(recordId), row);
    }
    tables.push({ table, rows: rows.length });
  }
  return { tables };
}

export type RefreshEntProjectionSubscriptionsOptions = {
  localDb: SyncDb;
  remoteDb: SyncDb;
  liveSource: LiveSource;
};

export async function refreshEntProjectionSubscriptions(
  options: RefreshEntProjectionSubscriptionsOptions,
): Promise<void> {
  const sheets = await loadSheetMeta(options.localDb);
  const desired = new Set(
    sheets
      .map((s) => s.table_name)
      .filter((t) => ENT_TABLE.test(t)),
  );

  // remove tables no longer present
  for (const [table, off] of [...unsubscribers]) {
    if (!desired.has(table)) {
      off();
      unsubscribers.delete(table);
      await clearLocalTable(options.localDb, table);
    }
  }

  // add new tables
  for (const table of desired) {
    if (unsubscribers.has(table)) continue;
    assertSafeTableName(table);
    const rows = await fetchRemoteRows(options.remoteDb, table);
    await clearLocalTable(options.localDb, table);
    for (const row of rows) {
      const recordId = row.id;
      if (recordId === undefined || recordId === null) continue;
      await upsertLocalRow(options.localDb, String(recordId), row);
    }
    const off = await options.liveSource.subscribe(table, async (message) =>
      applyLiveEntMessage(options.localDb, message),
    );
    unsubscribers.set(table, off);
  }
}

async function applyLiveEntMessage(localDb: SyncDb, message: LiveMessage): Promise<void> {
  try {
    if (message.action === "KILLED") {
      markDirtyProjectionData(true);
      return;
    }
    const recordId = String(message.recordId);
    if (message.action === "CREATE" || message.action === "UPDATE") {
      const { id: _id, ...content } = message.value;
      await localDb.query("UPSERT $record CONTENT $content", {
        record: new StringRecordId(recordId),
        content: { ...content, _origin_session_id: "remote:live" },
      });
      return;
    }
    if (message.action === "DELETE") {
      await localDb.query("DELETE $record", { record: new StringRecordId(recordId) });
    }
  } catch {
    markDirtyProjectionData(true);
  }
}

export async function stopEntProjectionSubscriptions(): Promise<void> {
  for (const off of unsubscribers.values()) off();
  unsubscribers = new Map();
}

async function loadSheetMeta(localDb: SyncDb): Promise<SheetMeta[]> {
  const rows = await localDb.query<[SheetMeta[]]>(
    `SELECT table_name, column_defs FROM sheet`,
  );
  const list = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : [];
  return list.filter((r): r is SheetMeta =>
    typeof r === "object" && r !== null && typeof (r as SheetMeta).table_name === "string",
  );
}

async function fetchRemoteRows(
  remoteDb: SyncDb,
  table: string,
): Promise<Array<Record<string, unknown>>> {
  const result = await remoteDb.query<[Array<Record<string, unknown>>]>(
    `SELECT * FROM type::table($table)`,
    { table },
  );
  return Array.isArray(result) && Array.isArray(result[0]) ? result[0] : [];
}

async function clearLocalTable(localDb: SyncDb, table: string): Promise<void> {
  await localDb.query(`DELETE FROM type::table($table)`, { table });
}

async function upsertLocalRow(
  localDb: SyncDb,
  recordId: string,
  row: Record<string, unknown>,
): Promise<void> {
  const { id: _id, ...content } = row;
  await localDb.query(`UPSERT $record CONTENT $content`, {
    record: new StringRecordId(recordId),
    content: { ...content, _origin_session_id: REBUILD_ORIGIN },
  });
}
