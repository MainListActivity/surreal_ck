import { applyRemoteChange } from "./apply-remote-change";
import type { SyncChange, SyncDb } from "./types";
import { StringRecordId } from "surrealdb";

export type SyncDeadLetter = {
  id: string;
  target_table: string;
  target_id: string;
  versionstamp: string;
  op: string;
  error_message: string;
  created_at?: unknown;
};

export async function recordDeadLetter(
  db: SyncDb,
  change: SyncChange,
  err: unknown,
): Promise<void> {
  await db.query(
    `UPSERT $id SET
       target_table = $targetTable,
       target_id = $targetId,
       versionstamp = $versionstamp,
       op = $op,
       error_message = $errorMessage,
       created_at = time::now()`,
    {
      id: new StringRecordId(`sync_dead_letter:${deadLetterId(change)}`),
      targetTable: change.table,
      targetId: change.recordId,
      versionstamp: change.versionstamp,
      op: change.op,
      errorMessage: err instanceof Error ? err.message : String(err),
    },
  );
}

export async function reconcileFromRemote(
  localDb: SyncDb,
  remoteDb: SyncDb,
  change: SyncChange,
  originTag = "remote:reconcile",
): Promise<void> {
  const rows = await remoteDb.query<[Record<string, unknown>[]]>(
    `SELECT * FROM $record`,
    { record: change.recordId },
  );
  const remoteRow = rows[0]?.[0];

  if (!remoteRow) {
    await localDb.query(`DELETE $record`, { record: change.recordId });
    return;
  }

  await applyRemoteChange(localDb, {
    table: change.table,
    versionstamp: change.versionstamp,
    op: "update",
    recordId: change.recordId,
    content: remoteRow,
  }, { originTag });
}

export async function listDeadLetters(
  db: SyncDb,
  options: { limit?: number; offset?: number } = {},
): Promise<SyncDeadLetter[]> {
  const rows = await db.query<[SyncDeadLetter[]]>(
    `SELECT * FROM sync_dead_letter ORDER BY created_at DESC LIMIT $limit START $offset`,
    { limit: options.limit ?? 50, offset: options.offset ?? 0 },
  );
  return rows[0] ?? [];
}

export async function discardDeadLetter(db: SyncDb, id: string): Promise<void> {
  await db.query(`DELETE $id`, { id: new StringRecordId(id) });
}

export async function forceReapplyDeadLetter(localDb: SyncDb, remoteDb: SyncDb, id: string): Promise<void> {
  const rows = await localDb.query<[SyncDeadLetter[]]>(
    `SELECT * FROM $id LIMIT 1`,
    { id: new StringRecordId(id) },
  );
  const letter = rows[0]?.[0];
  if (!letter) return;

  await reconcileFromRemote(localDb, remoteDb, {
    table: letter.target_table,
    versionstamp: letter.versionstamp,
    op: letter.op === "delete" ? "delete" : "update",
    recordId: letter.target_id,
    content: {},
  });
  await discardDeadLetter(localDb, id);
}

function deadLetterId(change: SyncChange): string {
  return `${change.table}__${change.versionstamp}`.replace(/[^a-zA-Z0-9_:.-]/g, "_");
}
