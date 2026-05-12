import { applyRemoteChange } from "./apply-remote-change";
import { showChangesQuery } from "./changefeed";
import { getCursor } from "./cursor";
import { markLocalChangefeedStale } from "./status";
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
    try {
      await options.localDb.query(showChangesQuery(table, localCursor));
    } catch (err) {
      if (isCursorTooOld(err)) {
        localChangefeedStale = true;
        markLocalChangefeedStale(true);
      } else {
        throw err;
      }
    }

    const remoteCursor = await getCursor(options.localDb, "remote_to_local", table);
    try {
      await options.remoteDb.query(showChangesQuery(table, remoteCursor));
    } catch (err) {
      if (!isCursorTooOld(err)) throw err;
      await rebuildTableFromRemote(options.localDb, options.remoteDb, table);
      rebuilt = true;
    }
  }

  return { localChangefeedStale, rebuilt };
}

async function rebuildTableFromRemote(localDb: SyncDb, remoteDb: SyncDb, table: string): Promise<void> {
  await localDb.query(`DELETE FROM type::table($table)`, { table });
  const rows = await remoteDb.query<[Array<Record<string, unknown>>]>(
    `SELECT * FROM type::table($table)`,
    { table },
  );
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
