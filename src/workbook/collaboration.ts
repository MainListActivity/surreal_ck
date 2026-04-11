import type { LiveMessage, LiveSubscription, Surreal } from 'surrealdb';
import { Table } from 'surrealdb';

import { toDateTime, toRecordId } from '../lib/surreal/record-id';
import type { MutationRecord } from '../lib/surreal/types';

export interface CollabMutation {
  workbook: string;
  command_id: string;
  params: Record<string, unknown>;
  client_id: string;
}

export interface ReplayableCommand {
  command_id: string;
  params: Record<string, unknown>;
}

// Commands that are safe to replay on remote clients.
// Extend this set as spike testing confirms additional command types.
export const COLLAB_COMMAND_WHITELIST = new Set([
  // NOTE: cell value mutations (set-range-values-mutation) are intentionally
  // excluded — they go directly to entity tables, not the collab mutation log.
  'sheet.mutation.set-worksheet-row-count-mutation',
  'sheet.mutation.set-worksheet-col-count-mutation',
  'sheet.mutation.insert-row-mutation',
  'sheet.mutation.remove-row-mutation',
  'sheet.mutation.insert-col-mutation',
  'sheet.mutation.remove-col-mutation',
  'sheet.mutation.set-range-formatted-values-mutation',
  'sheet.mutation.set-range-formula-mutation',
  'sheet.mutation.set-range-style-mutation',
  'sheet.mutation.set-range-data-validation-mutation',
  'sheet.mutation.merge-range-mutation',
  'sheet.mutation.unmerge-range-mutation',
  'sheet.mutation.move-range-mutation',
  'sheet.mutation.set-cell-comments-mutation',
]);

// How many mutations or how many seconds before we switch to snapshot sync
const SNAPSHOT_MUTATION_THRESHOLD = 50;
const SNAPSHOT_TIME_THRESHOLD_MS = 30_000;

export interface CollabController {
  /** Start capturing and broadcasting cell mutations. */
  start(): Promise<void>;
  /** Stop all LIVE SELECT subscriptions and cleanup. */
  stop(): void;
  /** Handle reconnection: replay gap or fall back to snapshot. */
  handleReconnect(lastKnownTs: string | null): Promise<'replay' | 'snapshot'>;
}

export function createCollabController(
  db: Surreal,
  workbookId: string,
  workspaceId: string,
  clientId: string,
  onRemoteCommand: (cmd: ReplayableCommand) => void,
  onSnapshotNeeded: () => void,
  onQueueWarning: (queuedCount: number) => void,
): CollabController {
  let liveQuery: LiveSubscription | null = null;
  let unsubscribeLive: (() => void) | null = null;
  let paused = false;
  const pendingBuffer: MutationRecord[] = [];
  const retryQueue: CollabMutation[] = [];
  const MAX_QUEUE = 500;

  const flushRetryQueue = async () => {
    while (retryQueue.length > 0) {
      const item = retryQueue[0];
      try {
        await db.query(
          `CREATE mutation CONTENT {
             workbook: $wb,
             command_id: $cmd,
             params: $params,
             client_id: $cid
           }`,
          {
            wb: toRecordId(workbookId),
            cmd: item.command_id,
            params: item.params,
            cid: item.client_id,
          },
        );
        retryQueue.shift();
      } catch {
        break;
      }
    }
  };

  const insertMutation = async (mutation: CollabMutation) => {
    try {
      await flushRetryQueue();
      await db.query(
        `CREATE mutation CONTENT {
           workbook: $wb,
           command_id: $cmd,
           params: $params,
           client_id: $cid
         }`,
        {
          wb: toRecordId(mutation.workbook),
          cmd: mutation.command_id,
          params: mutation.params,
          cid: mutation.client_id,
        },
      );
    } catch {
      if (retryQueue.length < MAX_QUEUE) {
        retryQueue.push(mutation);
      }
      // Drop oldest if at cap
      if (retryQueue.length >= MAX_QUEUE) {
        retryQueue.shift();
      }
      if (retryQueue.length >= 50) {
        onQueueWarning(retryQueue.length);
      }
    }
  };

  const applyRemote = (record: MutationRecord) => {
    if (record.client_id === clientId) {
      // Suppress our own mutations coming back from LIVE SELECT
      return;
    }

    if (!COLLAB_COMMAND_WHITELIST.has(record.command_id)) {
      void db
        .query(
          `CREATE client_error CONTENT {
             workspace: $ws,
             workbook: $wb,
             client_id: $cid,
             error_code: $code,
             message: $msg,
             meta: $meta
           }`,
          {
            wb: toRecordId(workbookId),
            ws: toRecordId(workspaceId),
            cid: clientId,
            code: 'unknown_command',
            msg: `Received unknown command_id: ${record.command_id}`,
            meta: { command_id: record.command_id },
          },
        )
        .catch(() => undefined);
      // Trigger snapshot resync for safety on unknown commands
      onSnapshotNeeded();
      return;
    }

    onRemoteCommand({ command_id: record.command_id, params: record.params });
  };

  const drainBuffer = () => {
    paused = false;
    for (const record of pendingBuffer.splice(0)) {
      applyRemote(record);
    }
  };

  const liveCallback = (record: MutationRecord) => {
    if (paused) {
      pendingBuffer.push(record);
      return;
    }

    applyRemote(record);
  };

  return {
    async start() {
      liveQuery = await db.live(new Table('mutation'));
      unsubscribeLive = liveQuery.subscribe((message) => {
        if (message.action !== 'CREATE') {
          return;
        }

        const record = message.value as unknown as MutationRecord;
        if (String(record.workbook) !== workbookId) {
          return;
        }

        liveCallback(record);
      });
    },

    stop() {
      unsubscribeLive?.();
      unsubscribeLive = null;

      if (liveQuery) {
        void liveQuery.kill().catch(() => undefined);
        liveQuery = null;
      }
    },

    async handleReconnect(lastKnownTs: string | null): Promise<'replay' | 'snapshot'> {
      // Re-subscribe first, buffering incoming events while we detect the gap
      unsubscribeLive?.();
      unsubscribeLive = null;

      if (liveQuery) {
        void liveQuery.kill().catch(() => undefined);
        liveQuery = null;
      }

      paused = true;
      pendingBuffer.length = 0;

      liveQuery = await db.live(new Table('mutation'));
      unsubscribeLive = liveQuery.subscribe((message) => {
        if (message.action !== 'CREATE') {
          return;
        }

        const record = message.value as unknown as MutationRecord;
        if (String(record.workbook) !== workbookId) {
          return;
        }

        liveCallback(record);
      });

      // Gap detection
      if (!lastKnownTs) {
        drainBuffer();
        return 'snapshot';
      }

      const nowMs = Date.now();
      const lastTs = new Date(lastKnownTs).getTime();
      const gapMs = nowMs - lastTs;

      const result = await db
        .query<[MutationRecord[]]>(
          `SELECT * FROM mutation WHERE workbook = $wb AND created_at > $ts ORDER BY created_at ASC`,
          { wb: toRecordId(workbookId), ts: toDateTime(lastKnownTs) },
        )
        .catch(() => [[]] as [MutationRecord[]]);

      const missed = result[0] ?? [];

      if (gapMs > SNAPSHOT_TIME_THRESHOLD_MS || missed.length > SNAPSHOT_MUTATION_THRESHOLD) {
        paused = false;
        pendingBuffer.length = 0;
        onSnapshotNeeded();
        return 'snapshot';
      }

      // Replay missed mutations in order
      for (const record of missed) {
        if (record.client_id !== clientId && COLLAB_COMMAND_WHITELIST.has(record.command_id)) {
          onRemoteCommand({ command_id: record.command_id, params: record.params });
        }
      }

      drainBuffer();
      return 'replay';
    },
  };
}

/** Capture handler: call this from the Univer CommandExecuted listener. */
export function shouldBroadcastCommand(
  commandId: string,
  commandType: number,
  fromCollab: boolean,
): boolean {
  // Only broadcast MUTATION type (type === 2), not from collab replay
  return commandType === 2 && !fromCollab && COLLAB_COMMAND_WHITELIST.has(commandId);
}
