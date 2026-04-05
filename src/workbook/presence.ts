import type { LiveMessage, Surreal } from 'surrealdb';
import { Table } from 'surrealdb';

export interface PresenceRecord {
  id?: string;
  client_id: string;
  expires_at: string;
}

const PRESENCE_TTL_MS = 60_000;
const PRESENCE_REFRESH_MS = 20_000;

/**
 * Manages a presence heartbeat for the given workbook.
 * Returns a cleanup function that stops the heartbeat and removes the record.
 */
export function startPresenceHeartbeat(
  db: Surreal,
  workspaceId: string,
  workbookId: string,
  clientId: string,
): () => void {
  let stopped = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let presenceId: string | null = null;

  const upsert = async () => {
    if (stopped) {
      return;
    }

    const expiresAt = new Date(Date.now() + PRESENCE_TTL_MS).toISOString();

    try {
      if (!presenceId) {
        const result = await db.query<[string[]]>(
          `LET $presence = (CREATE presence CONTENT $data RETURN AFTER)[0];
           RELATE $ws->workspace_has_presence->$presence;
           RELATE $wb->workbook_has_presence->$presence;
           RETURN $presence.id`,
          {
            data: {
              client_id: clientId,
              expires_at: expiresAt,
            },
            ws: workspaceId,
            wb: workbookId,
          },
        );
        presenceId = result[0]?.[0] ?? null;
      } else {
        await db.query(`UPDATE $id SET expires_at = $exp`, {
          id: presenceId,
          exp: expiresAt,
        });
      }
    } catch {
      // Network may be down; retry on next tick
      presenceId = null;
    }

    if (!stopped) {
      timerId = setTimeout(() => void upsert(), PRESENCE_REFRESH_MS);
    }
  };

  void upsert();

  return () => {
    stopped = true;
    if (timerId !== null) {
      clearTimeout(timerId);
    }

    if (presenceId) {
      void db.query(
        `DELETE workspace_has_presence WHERE out = $id;
         DELETE workbook_has_presence WHERE out = $id;
         DELETE $id`,
        { id: presenceId },
      ).catch(() => undefined);
    }
  };
}

/**
 * Watches the presence table for the given workbook and returns the lowest
 * client_id (coordinator) among currently active presences.
 * Calls onCoordinatorChange when the coordinator changes.
 * Returns a cleanup function.
 */
export async function watchCoordinator(
  db: Surreal,
  workbookId: string,
  clientId: string,
  onCoordinatorChange: (isCoordinator: boolean) => void,
): Promise<() => void> {
  const getLowest = async (): Promise<string | null> => {
    const now = new Date().toISOString();
    const result = await db.query<[PresenceRecord[]]>(
      `SELECT out.client_id AS client_id
       FROM workbook_has_presence
       WHERE in = $wb AND out.expires_at > $now
       ORDER BY out.client_id ASC
       LIMIT 1`,
      { wb: workbookId, now },
    );
    return (result[0]?.[0] as PresenceRecord | undefined)?.client_id ?? null;
  };

  const check = async () => {
    const lowest = await getLowest().catch(() => null);
    onCoordinatorChange(lowest === clientId || lowest === null);
  };

  await check();

  const liveQuery = await db.live(new Table('presence'));
  const unsubscribe = liveQuery.subscribe((message: LiveMessage) => {
    if (message.action === 'CREATE' || message.action === 'DELETE' || message.action === 'UPDATE') {
      void check();
    }
  });

  return () => {
    unsubscribe();
    void liveQuery.kill().catch(() => undefined);
  };
}
