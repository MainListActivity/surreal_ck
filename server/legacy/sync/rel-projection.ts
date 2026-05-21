import { StringRecordId } from "surrealdb";
import { markDirtyProjectionData } from "./status";
import { assertSafeTableName } from "./table-name";
import type { LiveMessage, LiveSource, SyncDb } from "./types";

export type RefreshRelProjectionSubscriptionsOptions = {
  localDb: SyncDb;
  remoteDb: SyncDb;
  liveSource: LiveSource;
};

export type RebuildRelProjectionsOptions = {
  localDb: SyncDb;
  remoteDb: SyncDb;
};

type EdgeCatalogMeta = {
  rel_table: string;
  workspace: string;
};

const REBUILD_ORIGIN = "remote:projection-rebuild";
const REL_TABLE = /^rel_[a-z0-9_]+$/;

type Subscription = {
  off: () => void;
  workspace: string;
};

let subscriptions = new Map<string, Subscription>();

export async function rebuildRelProjections(
  options: RebuildRelProjectionsOptions,
): Promise<{ tables: Array<{ table: string; rows: number }> }> {
  const catalog = await loadEdgeCatalogMeta(options.localDb);
  const tables: Array<{ table: string; rows: number }> = [];
  for (const meta of catalog) {
    const table = meta.rel_table;
    if (!REL_TABLE.test(table)) continue;
    assertSafeTableName(table);
    const rows = await fetchRemoteRows(options.remoteDb, table);
    await clearLocalTableForWorkspace(options.localDb, table, String(meta.workspace));
    for (const row of rows) {
      const recordId = row.id;
      if (recordId === undefined || recordId === null) continue;
      await upsertLocalRow(options.localDb, String(recordId), row);
    }
    tables.push({ table, rows: rows.length });
  }
  return { tables };
}

export async function refreshRelProjectionSubscriptions(
  options: RefreshRelProjectionSubscriptionsOptions,
): Promise<void> {
  const catalog = await loadEdgeCatalogMeta(options.localDb);
  const desired = new Map<string, string>();
  for (const meta of catalog) {
    if (!REL_TABLE.test(meta.rel_table)) continue;
    desired.set(meta.rel_table, String(meta.workspace));
  }

  // remove tables no longer present
  for (const [table, sub] of [...subscriptions]) {
    if (!desired.has(table)) {
      sub.off();
      subscriptions.delete(table);
      await clearLocalTableForWorkspace(options.localDb, table, sub.workspace);
    }
  }

  // add new tables
  for (const [table, workspace] of desired) {
    if (subscriptions.has(table)) continue;
    assertSafeTableName(table);
    const rows = await fetchRemoteRows(options.remoteDb, table);
    await clearLocalTableForWorkspace(options.localDb, table, workspace);
    for (const row of rows) {
      const recordId = row.id;
      if (recordId === undefined || recordId === null) continue;
      await upsertLocalRow(options.localDb, String(recordId), row);
    }
    const off = await options.liveSource.subscribe(table, async (message) =>
      applyLiveRelMessage(options.localDb, message),
    );
    subscriptions.set(table, { off, workspace });
  }
}

export async function stopRelProjectionSubscriptions(): Promise<void> {
  for (const sub of subscriptions.values()) sub.off();
  subscriptions = new Map();
}

async function loadEdgeCatalogMeta(localDb: SyncDb): Promise<EdgeCatalogMeta[]> {
  const rows = await localDb.query<[EdgeCatalogMeta[]]>(
    `SELECT rel_table, workspace FROM edge_catalog`,
  );
  const list = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : [];
  return list.filter((r): r is EdgeCatalogMeta =>
    typeof r === "object" && r !== null && typeof (r as EdgeCatalogMeta).rel_table === "string",
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

async function clearLocalTableForWorkspace(
  localDb: SyncDb,
  table: string,
  workspace: string,
): Promise<void> {
  await localDb.query(
    `DELETE FROM type::table($table) WHERE workspace = $workspace`,
    { table, workspace },
  );
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

async function applyLiveRelMessage(localDb: SyncDb, message: LiveMessage): Promise<void> {
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
