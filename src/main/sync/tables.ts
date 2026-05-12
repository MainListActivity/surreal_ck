import { isInSyncScope, SYNC_SCOPE } from "./scope";
import { wrapSyncOperationError } from "./operation-error";
import type { SyncDb } from "./types";

export async function enumerateSyncTables(db: SyncDb): Promise<string[]> {
  const fixed = SYNC_SCOPE.map((entry) => entry.table);
  const dynamic = await listDynamicSyncTables(db);
  return Array.from(new Set([...fixed, ...dynamic])).sort();
}

async function listDynamicSyncTables(db: SyncDb): Promise<string[]> {
  let rows: [{ tables?: Record<string, unknown> }];
  try {
    rows = await db.query<[{ tables?: Record<string, unknown> }]>(`INFO FOR DB`);
  } catch (err) {
    throw wrapSyncOperationError(`local sync table enumeration query="INFO FOR DB"`, err);
  }
  const tableNames = Object.keys(rows[0]?.tables ?? {});
  return tableNames.filter((table) => isInSyncScope(table) && !SYNC_SCOPE.some((entry) => entry.table === table));
}
