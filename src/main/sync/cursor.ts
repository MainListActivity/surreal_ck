import type { SyncDb, SyncDirection } from "./types";
import { StringRecordId } from "surrealdb";

export function cursorId(direction: SyncDirection, table: string): string {
  return `${direction}__${table}`;
}

export async function getCursor(db: SyncDb, direction: SyncDirection, table: string): Promise<string> {
  const rows = await db.query<[{ versionstamp?: string }[]]>(
    `SELECT versionstamp FROM $id LIMIT 1`,
    { id: new StringRecordId(`sync_cursor:${cursorId(direction, table)}`) },
  );
  return rows[0]?.[0]?.versionstamp ?? "0";
}

export async function advanceCursor(
  db: SyncDb,
  direction: SyncDirection,
  table: string,
  versionstamp: string,
): Promise<void> {
  await db.query(
    `UPSERT $id SET
       direction = $direction,
       target_table = $table,
       versionstamp = $versionstamp,
       updated_at = time::now()`,
    {
      id: new StringRecordId(`sync_cursor:${cursorId(direction, table)}`),
      direction,
      table,
      versionstamp,
    },
  );
}
