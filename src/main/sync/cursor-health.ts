import { applyRemoteChange } from "./apply-remote-change";
import { showChangesQuery } from "./changefeed";
import { getCursor } from "./cursor";
import { markLocalChangefeedStale } from "./status";
import { wrapSyncOperationError } from "./operation-error";
import type { SyncDb } from "./types";

export type CursorHealthOptions = {
  localDb: SyncDb;
  remoteDb: SyncDb;
  tables: string[];
};

export type CursorHealthResult = {
  localChangefeedStale: boolean;
  rebuilt: boolean;
};

export async function checkCursorHealthAndRebuild(options: CursorHealthOptions): Promise<CursorHealthResult> {
  let localChangefeedStale = false;
  let rebuilt = false;

  for (const table of options.tables) {
    const localCursor = await getCursor(options.localDb, "local_to_remote", table);
    const localHealthOperation =
      `local changefeed health check table=${table} cursor=${localCursor} query="SHOW CHANGES FOR TABLE ${table} SINCE ${localCursor}"`;
    try {
      await options.localDb.query(showChangesQuery(table, localCursor));
    } catch (err) {
      if (isCursorTooOld(err)) {
        localChangefeedStale = true;
        markLocalChangefeedStale(true);
      } else {
        throw wrapSyncOperationError(localHealthOperation, err);
      }
    }

    const remoteCursor = await getCursor(options.localDb, "remote_to_local", table);
    const remoteHealthOperation =
      `remote changefeed health check table=${table} cursor=${remoteCursor} query="SHOW CHANGES FOR TABLE ${table} SINCE ${remoteCursor}"`;
    try {
      await options.remoteDb.query(showChangesQuery(table, remoteCursor));
    } catch (err) {
      if (!isCursorTooOld(err)) throw wrapSyncOperationError(remoteHealthOperation, err);
      await rebuildTableFromRemote(options.localDb, options.remoteDb, table);
      rebuilt = true;
    }
  }

  return { localChangefeedStale, rebuilt };
}

async function rebuildTableFromRemote(localDb: SyncDb, remoteDb: SyncDb, table: string): Promise<void> {
  try {
    await localDb.query(`DELETE FROM type::table($table)`, { table });
  } catch (err) {
    throw wrapSyncOperationError(
      `local table rebuild clear table=${table} query="DELETE FROM type::table($table)" bindings.table=${table}`,
      err,
    );
  }

  let rows: [Array<Record<string, unknown>>];
  try {
    rows = await remoteDb.query<[Array<Record<string, unknown>>]>(
      `SELECT * FROM type::table($table)`,
      { table },
    );
  } catch (err) {
    throw wrapSyncOperationError(
      `remote table rebuild fetch table=${table} query="SELECT * FROM type::table($table)" bindings.table=${table}`,
      err,
    );
  }
  for (const row of rows[0] ?? []) {
    if (!row.id) continue;
    await applyRemoteChange(localDb, {
      table,
      versionstamp: "rebuild",
      op: "create",
      recordId: String(row.id),
      content: row,
    }, { originTag: "remote:rebuild" });
  }
}

function isCursorTooOld(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /cursor.*too old|changefeed.*expired|versionstamp.*old/i.test(message);
}
