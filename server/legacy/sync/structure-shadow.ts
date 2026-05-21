import { StringRecordId } from "surrealdb";
import { wrapSyncOperationError } from "./operation-error";
import { assertSafeTableName } from "./table-name";
import type { SyncDb } from "./types";

export const FIXED_STRUCTURE_SHADOW_TABLES = [
  "app_user",
  "workspace",
  "has_workspace_member",
  "pending_workspace_member",
  "folder",
  "workbook",
  "sheet",
  "edge_catalog",
] as const;

export type FixedStructureShadowTable = typeof FIXED_STRUCTURE_SHADOW_TABLES[number];

export type RebuildFixedSharedStructureShadowOptions = {
  localDb: SyncDb;
  remoteDb: SyncDb;
  tables?: readonly FixedStructureShadowTable[];
};

export type RebuildFixedSharedStructureShadowResult = {
  tables: Array<{ table: FixedStructureShadowTable; rows: number }>;
  totalRows: number;
};

type ShadowSnapshot = {
  table: FixedStructureShadowTable;
  rows: Array<Record<string, unknown>>;
};

const REBUILD_ORIGIN = "remote:structure-rebuild";

export async function rebuildFixedSharedStructureShadow({
  localDb,
  remoteDb,
  tables = FIXED_STRUCTURE_SHADOW_TABLES,
}: RebuildFixedSharedStructureShadowOptions): Promise<RebuildFixedSharedStructureShadowResult> {
  for (const table of tables) {
    assertSafeTableName(table);
  }

  const snapshots: ShadowSnapshot[] = [];
  for (const table of tables) {
    snapshots.push({ table, rows: await fetchRemoteTable(remoteDb, table) });
  }

  for (const table of [...tables].reverse()) {
    await clearLocalTable(localDb, table);
  }

  const tableResults: RebuildFixedSharedStructureShadowResult["tables"] = [];
  let totalRows = 0;
  for (const snapshot of snapshots) {
    let appliedRows = 0;
    for (const row of snapshot.rows) {
      const recordId = row.id;
      if (recordId === undefined || recordId === null) continue;
      await upsertLocalRow(localDb, String(recordId), row);
      appliedRows += 1;
    }
    tableResults.push({ table: snapshot.table, rows: appliedRows });
    totalRows += appliedRows;
  }

  return { tables: tableResults, totalRows };
}

async function fetchRemoteTable(
  remoteDb: SyncDb,
  table: FixedStructureShadowTable,
): Promise<Array<Record<string, unknown>>> {
  try {
    const rows = await remoteDb.query<[Array<Record<string, unknown>>]>(
      `SELECT * FROM type::table($table)`,
      { table },
    );
    return firstResultArray(rows);
  } catch (err) {
    throw wrapSyncOperationError(
      `fixed structure shadow rebuild remote fetch table=${table} query="SELECT * FROM type::table($table)" bindings.table=${table}`,
      err,
    );
  }
}

async function clearLocalTable(localDb: SyncDb, table: FixedStructureShadowTable): Promise<void> {
  try {
    await localDb.query(`DELETE FROM type::table($table)`, { table });
  } catch (err) {
    throw wrapSyncOperationError(
      `fixed structure shadow rebuild local clear table=${table} query="DELETE FROM type::table($table)" bindings.table=${table}`,
      err,
    );
  }
}

async function upsertLocalRow(
  localDb: SyncDb,
  recordId: string,
  row: Record<string, unknown>,
): Promise<void> {
  try {
    await localDb.query(
      `UPSERT $record CONTENT $content`,
      {
        record: new StringRecordId(recordId),
        content: localShadowContent(row),
      },
    );
  } catch (err) {
    throw wrapSyncOperationError(
      `fixed structure shadow rebuild local upsert record=${recordId} query="UPSERT $record CONTENT $content"`,
      err,
    );
  }
}

function localShadowContent(row: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...content } = row;
  return { ...content, _origin_session_id: REBUILD_ORIGIN };
}

function firstResultArray(result: unknown): Array<Record<string, unknown>> {
  const rows = Array.isArray(result) && Array.isArray(result[0])
    ? result[0]
    : Array.isArray(result)
      ? result
      : [];
  return rows.filter((row): row is Record<string, unknown> =>
    typeof row === "object" && row !== null && !Array.isArray(row),
  );
}
