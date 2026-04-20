import type { DbAdapter } from '../lib/surreal/db-adapter';
import { nowDateTime, toRecordId } from '../lib/surreal/record-id';
import type { SnapshotRecord } from '../lib/surreal/types';

const SNAPSHOT_MUTATION_COUNT = 100;
const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1_000; // 10 minutes

export interface SnapshotController {
  start(isCoordinator: boolean): Promise<void>;
  onMutationApplied(): void;
  setCoordinator(isCoordinator: boolean): void;
  forceSnapshot(): Promise<void>;
  stop(): void;
  loadLatest(): Promise<SnapshotRecord | null>;
}

export function createSnapshotController(
  db: DbAdapter,
  workbookId: string,
  clientId: string,
  getWorkbookData: () => Record<string, unknown>,
  onSnapshotReceived: (snapshot: SnapshotRecord) => void,
): SnapshotController {
  let isCoordinator = false;
  let mutationCount = 0;
  let snapshotTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribeLive: (() => void) | null = null;
  let lastSnapshotTs: string | null = null;

  const writeSnapshot = async () => {
    if (!isCoordinator) return;

    try {
      const layout = getWorkbookData();
      const rows = await db.query<SnapshotRecord[]>(
        `CREATE snapshot CONTENT {
           workbook: $wb,
           layout: $layout,
           coordinator_client_id: $cid,
           mutation_watermark: $wm
         } RETURN AFTER`,
        {
          wb: toRecordId(workbookId),
          layout,
          cid: clientId,
          wm: nowDateTime(),
        },
      );
      const created = Array.isArray(rows) ? rows[0] : null;
      lastSnapshotTs = (created as SnapshotRecord | undefined)?.created_at ?? null;
      mutationCount = 0;
    } catch {
      // Non-fatal — will retry on next trigger
    }
  };

  const startCoordinatorTimers = () => {
    if (snapshotTimer) clearInterval(snapshotTimer);
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

      // 通过 CHANGEFEED IPC 订阅 snapshot 表的实时变更
      unsubscribeLive = db.subscribe<SnapshotRecord>('snapshot', (message) => {
        if (message.action !== 'CREATE' || !message.record) return;

        const snap = message.record;
        if (String(snap.workbook) !== workbookId) return;

        if (!lastSnapshotTs || snap.created_at > lastSnapshotTs) {
          lastSnapshotTs = snap.created_at;
          onSnapshotReceived(snap);
        }
      });
    },

    onMutationApplied() {
      mutationCount++;
      if (isCoordinator && mutationCount >= SNAPSHOT_MUTATION_COUNT) {
        void writeSnapshot();
      }
    },

    async forceSnapshot() {
      await writeSnapshot();
    },

    setCoordinator(coordinator: boolean) {
      const tookOver = coordinator && !isCoordinator;
      isCoordinator = coordinator;
      if (isCoordinator) {
        startCoordinatorTimers();
        if (tookOver) void writeSnapshot();
      } else {
        stopCoordinatorTimers();
      }
    },

    stop() {
      stopCoordinatorTimers();
      unsubscribeLive?.();
      unsubscribeLive = null;
    },

    async loadLatest(): Promise<SnapshotRecord | null> {
      const rows = await db
        .query<SnapshotRecord[]>(
          `SELECT * FROM snapshot WHERE workbook = $wb ORDER BY created_at DESC LIMIT 1`,
          { wb: toRecordId(workbookId) },
        )
        .catch(() => [] as SnapshotRecord[]);

      const snap = Array.isArray(rows) ? rows[0] ?? null : null;
      if (snap) lastSnapshotTs = snap.created_at;
      return snap;
    },
  };
}
