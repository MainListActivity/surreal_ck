import type { DbAdapter } from '../lib/surreal/db-adapter';
import { nowDateTime, toDateTime, toRecordId } from '../lib/surreal/record-id';

export interface PresenceRecord {
  id?: string;
  client_id: string;
  expires_at: string | Date;
}

const PRESENCE_TTL_MS = 60_000;
const PRESENCE_REFRESH_MS = 20_000;

export function startPresenceHeartbeat(
  db: DbAdapter,
  workbookId: string,
  clientId: string,
): () => void {
  let stopped = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;

  const upsert = async () => {
    if (stopped) return;

    const expiresAt = toDateTime(new Date(Date.now() + PRESENCE_TTL_MS));

    try {
      await db.query(
        `UPSERT presence
           SET workbook = $wb, client_id = $cid, expires_at = $exp
           WHERE workbook = $wb AND client_id = $cid`,
        { wb: toRecordId(workbookId), cid: clientId, exp: expiresAt },
      );
    } catch {
      // Network may be down; retry on next tick
    }

    if (!stopped) {
      timerId = setTimeout(() => void upsert(), PRESENCE_REFRESH_MS);
    }
  };

  void upsert();

  return () => {
    stopped = true;
    if (timerId !== null) clearTimeout(timerId);

    void db
      .query(`DELETE presence WHERE workbook = $wb AND client_id = $cid`, {
        wb: toRecordId(workbookId),
        cid: clientId,
      })
      .catch(() => undefined);
  };
}

export async function watchCoordinator(
  db: DbAdapter,
  workbookId: string,
  clientId: string,
  onCoordinatorChange: (isCoordinator: boolean) => void,
): Promise<() => void> {
  const getLowest = async (): Promise<string | null> => {
    const rows = await db.query<PresenceRecord[]>(
      `SELECT client_id FROM presence
       WHERE workbook = $wb AND expires_at > $now
       ORDER BY client_id ASC
       LIMIT 1`,
      { wb: toRecordId(workbookId), now: nowDateTime() },
    );
    return (Array.isArray(rows) ? rows[0] : null)?.client_id ?? null;
  };

  const check = async () => {
    const lowest = await getLowest().catch(() => null);
    onCoordinatorChange(lowest === clientId || lowest === null);
  };

  await check();

  // 通过 CHANGEFEED IPC 订阅 presence 表变更
  const unsubscribe = db.subscribe('presence', (message) => {
    if (message.action === 'CREATE' || message.action === 'DELETE' || message.action === 'UPDATE') {
      void check();
    }
  });

  return unsubscribe;
}
