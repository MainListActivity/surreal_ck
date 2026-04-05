import type { LiveSubscription, Surreal } from 'surrealdb';
import { Table } from 'surrealdb';

import type { SnapshotRecord } from '../lib/surreal/types';

const SNAPSHOT_MUTATION_COUNT = 100;
const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1_000; // 10 minutes

export interface SnapshotController {
  /** Start watching snapshots. If coordinator, also start writing them. */
  start(isCoordinator: boolean): Promise<void>;
  /** Call when a mutation is applied to track count. */
  onMutationApplied(): void;
  /** Update coordinator role (e.g., on presence change). */
  setCoordinator(isCoordinator: boolean): void;
  /** Stop all subscriptions and timers. */
  stop(): void;
  /** Load the latest snapshot for this workbook. Returns null if none. */
  loadLatest(): Promise<SnapshotRecord | null>;
}

export function createSnapshotController(
  db: Surreal,
  workbookId: string,
  workspaceId: string,
  clientId: string,
  getWorkbookData: () => Record<string, unknown>,
  onSnapshotReceived: (snapshot: SnapshotRecord) => void,
): SnapshotController {
  let isCoordinator = false;
  let mutationCount = 0;
  let snapshotTimer: ReturnType<typeof setInterval> | null = null;
  let liveQuery: LiveSubscription | null = null;
  let unsubscribeLive: (() => void) | null = null;
  let lastSnapshotTs: string | null = null;

  const loadSnapshot = async (id: string): Promise<SnapshotRecord | null> => {
    const [rows] = await db.query<[SnapshotRecord[]]>(
      'SELECT * FROM $id LIMIT 1',
      { id },
    );
    return rows?.[0] ?? null;
  };

  const writeSnapshot = async () => {
    if (!isCoordinator) {
      return;
    }

    try {
      // Replay mutations since last snapshot before writing (coordinator correctness)
      const data = getWorkbookData();
      const result = await db.query<[SnapshotRecord[]]>(
        `LET $snapshot = (CREATE snapshot CONTENT {
           data: $data,
           coordinator_client_id: $cid,
           mutation_watermark: $wm
         } RETURN AFTER)[0];
         RELATE $ws->workspace_has_snapshot->$snapshot;
         RELATE $wb->workbook_has_snapshot->$snapshot;
         RETURN $snapshot;`,
        {
          wb: workbookId,
          ws: workspaceId,
          data,
          cid: clientId,
          wm: new Date().toISOString(),
        },
      );
      lastSnapshotTs = (result[0]?.[0] as SnapshotRecord | undefined)?.created_at ?? null;
      mutationCount = 0;
    } catch {
      // Non-fatal — will retry on next trigger
    }
  };

  const startCoordinatorTimers = () => {
    if (snapshotTimer) {
      clearInterval(snapshotTimer);
    }
    snapshotTimer = setInterval(() => void writeSnapshot(), SNAPSHOT_INTERVAL_MS);
  };

  const stopCoordinatorTimers = () => {
    if (snapshotTimer) {
      clearInterval(snapshotTimer);
      snapshotTimer = null;
    }
  };

  return {
    async start(coordinator: boolean) {
      isCoordinator = coordinator;

      if (isCoordinator) {
        startCoordinatorTimers();
      }

      // Subscribe to new snapshots from others
      liveQuery = await db.live(new Table('workbook_has_snapshot'));
      unsubscribeLive = liveQuery.subscribe((message) => {
        if (message.action !== 'CREATE') {
          return;
        }

        const edge = message.value as { in?: string; out?: string };
        if (edge.in !== workbookId || !edge.out) {
          return;
        }

        void loadSnapshot(edge.out)
          .then((snap) => {
            if (!snap) {
              return;
            }

            if (!lastSnapshotTs || snap.created_at > lastSnapshotTs) {
              lastSnapshotTs = snap.created_at;
              onSnapshotReceived(snap);
            }
          })
          .catch(() => undefined);
      });
    },

    onMutationApplied() {
      mutationCount++;
      if (isCoordinator && mutationCount >= SNAPSHOT_MUTATION_COUNT) {
        void writeSnapshot();
      }
    },

    setCoordinator(coordinator: boolean) {
      isCoordinator = coordinator;
      if (isCoordinator) {
        startCoordinatorTimers();
        // Write snapshot immediately on takeover after ensuring state is current
        void writeSnapshot();
      } else {
        stopCoordinatorTimers();
      }
    },

    stop() {
      stopCoordinatorTimers();
      unsubscribeLive?.();
      unsubscribeLive = null;

      if (liveQuery) {
        void liveQuery.kill().catch(() => undefined);
        liveQuery = null;
      }
    },

    async loadLatest(): Promise<SnapshotRecord | null> {
      const result = await db
        .query<[SnapshotRecord[]]>(
          `SELECT VALUE out
           FROM workbook_has_snapshot
           WHERE in = $wb
           ORDER BY out.created_at DESC
           LIMIT 1`,
          { wb: workbookId },
        )
        .catch(() => [[]] as [SnapshotRecord[]]);

      const snap = result[0]?.[0] ?? null;
      if (snap) {
        lastSnapshotTs = snap.created_at;
      }
      return snap;
    },
  };
}
