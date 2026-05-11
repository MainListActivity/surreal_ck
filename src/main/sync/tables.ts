import { isInSyncScope, SYNC_SCOPE } from "./scope";
import type { SyncDb } from "./types";

export async function enumerateSyncTables(db: SyncDb): Promise<string[]> {
  const fixed = SYNC_SCOPE.map((entry) => entry.table);
  const dynamic = await listDynamicSyncTables(db);
  return Array.from(new Set([...fixed, ...dynamic])).sort();
}

async function listDynamicSyncTables(db: SyncDb): Promise<string[]> {
  const rows = await db.query<[{ tables?: Record<string, unknown> }]>(`INFO FOR DB`);
  const tableNames = Object.keys(rows[0]?.tables ?? {});
  return tableNames.filter((table) => isInSyncScope(table) && !SYNC_SCOPE.some((entry) => entry.table === table));
}
