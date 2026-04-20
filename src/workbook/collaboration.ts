import type { DbAdapter } from '../lib/surreal/db-adapter';
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

export const COLLAB_COMMAND_WHITELIST = new Set([
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

const SNAPSHOT_MUTATION_THRESHOLD = 50;
const SNAPSHOT_TIME_THRESHOLD_MS = 30_000;

export interface CollabController {
  start(): Promise<void>;
  stop(): void;
  handleReconnect(lastKnownTs: string | null): Promise<'replay' | 'snapshot'>;
}

export function createCollabController(
  db: DbAdapter,
  workbookId: string,
  workspaceId: string,
  clientId: string,
  onRemoteCommand: (cmd: ReplayableCommand) => void,
  onSnapshotNeeded: () => void,
  onQueueWarning: (queuedCount: number) => void,
): CollabController {
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
          { wb: toRecordId(workbookId), cmd: item.command_id, params: item.params, cid: item.client_id },
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
        { wb: toRecordId(mutation.workbook), cmd: mutation.command_id, params: mutation.params, cid: mutation.client_id },
      );
    } catch {
      if (retryQueue.length < MAX_QUEUE) retryQueue.push(mutation);
      if (retryQueue.length >= MAX_QUEUE) retryQueue.shift();
      if (retryQueue.length >= 50) onQueueWarning(retryQueue.length);
    }
  };

  // expose insertMutation for callers (used by univer.ts)
  (createCollabController as unknown as { _insertMutation?: unknown })._insertMutation = insertMutation;

  const applyRemote = (record: MutationRecord) => {
    if (record.client_id === clientId) return;

    if (!COLLAB_COMMAND_WHITELIST.has(record.command_id)) {
      void db.query(
        `CREATE client_error CONTENT {
           workspace: $ws, workbook: $wb, client_id: $cid,
           error_code: $code, message: $msg, meta: $meta
         }`,
        {
          wb: toRecordId(workbookId), ws: toRecordId(workspaceId), cid: clientId,
          code: 'unknown_command', msg: `Received unknown command_id: ${record.command_id}`,
          meta: { command_id: record.command_id },
        },
      ).catch(() => undefined);
      onSnapshotNeeded();
      return;
    }

    onRemoteCommand({ command_id: record.command_id, params: record.params });
  };

  const drainBuffer = () => {
    paused = false;
    for (const record of pendingBuffer.splice(0)) applyRemote(record);
  };

  const liveCallback = (record: MutationRecord) => {
    if (paused) { pendingBuffer.push(record); return; }
    applyRemote(record);
  };

  const startLive = () => {
    unsubscribeLive = db.subscribe<MutationRecord>('mutation', (message) => {
      if (message.action !== 'CREATE' || !message.record) return;
      const record = message.record;
      if (String(record.workbook) !== workbookId) return;
      liveCallback(record);
    });
  };

  const stopLive = () => {
    unsubscribeLive?.();
    unsubscribeLive = null;
  };

  return {
    async start() {
      startLive();
    },

    stop() {
      stopLive();
    },

    async handleReconnect(lastKnownTs: string | null): Promise<'replay' | 'snapshot'> {
      stopLive();
      paused = true;
      pendingBuffer.length = 0;
      startLive();

      if (!lastKnownTs) { drainBuffer(); return 'snapshot'; }

      const nowMs = Date.now();
      const gapMs = nowMs - new Date(lastKnownTs).getTime();

      const rows = await db
        .query<MutationRecord[]>(
          `SELECT * FROM mutation WHERE workbook = $wb AND created_at > $ts ORDER BY created_at ASC`,
          { wb: toRecordId(workbookId), ts: toDateTime(lastKnownTs) },
        )
        .catch(() => [] as MutationRecord[]);

      const missed = Array.isArray(rows) ? rows : [];

      if (gapMs > SNAPSHOT_TIME_THRESHOLD_MS || missed.length > SNAPSHOT_MUTATION_THRESHOLD) {
        paused = false;
        pendingBuffer.length = 0;
        onSnapshotNeeded();
        return 'snapshot';
      }

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

export function shouldBroadcastCommand(
  commandId: string,
  commandType: number,
  fromCollab: boolean,
): boolean {
  return commandType === 2 && !fromCollab && COLLAB_COMMAND_WHITELIST.has(commandId);
}
