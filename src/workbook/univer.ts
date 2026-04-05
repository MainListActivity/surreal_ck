import type { Surreal } from 'surrealdb';

import { createCollabController, shouldBroadcastCommand } from './collaboration';
import { startPresenceHeartbeat, watchCoordinator } from './presence';
import { createSnapshotController } from './snapshot';

export interface UniverBootstrapOptions {
  db: Surreal;
  workbookId: string;
  workspaceId: string;
  clientId: string;
  container: HTMLElement;
  onSyncWarning?: (message: string) => void;
  onSnapshotNeeded?: () => void;
}

export interface UniverInstance {
  /** Tear down Univer and all collab subscriptions. */
  destroy(): void;
  /** Get current workbook data for snapshot serialization. */
  getWorkbookData(): Record<string, unknown>;
}

/**
 * Bootstrap a Univer spreadsheet, wire up collab capture/replay,
 * snapshot coordination, and presence.
 *
 * Univer is loaded dynamically (dynamic import) to keep it out of the critical
 * path for routes that don't mount a workbook.
 */
export async function bootstrapUniver(opts: UniverBootstrapOptions): Promise<UniverInstance> {
  const { db, workbookId, workspaceId, clientId, container, onSyncWarning, onSnapshotNeeded } = opts;

  const { createUniver } = await import('@univerjs/presets');
  const { UniverSheetsCorePreset } = await import('@univerjs/preset-sheets-core');

  const { univer, univerAPI } = createUniver({
    presets: [
      UniverSheetsCorePreset({
        container,
      }),
    ],
  });

  // Create an empty workbook as starting point
  univerAPI.createUniverSheet({});

  // Helper: get active workbook data for snapshots
  const getWorkbookData = (): Record<string, unknown> => {
    try {
      const wb = univerAPI.getActiveWorkbook();
      if (!wb) return {};
      // @ts-expect-error — save() is available on FWorkbook but not yet typed in presets
      return (wb.save?.() as Record<string, unknown>) ?? {};
    } catch {
      return {};
    }
  };

  // Helper: reload workbook from snapshot data (replaces current sheet)
  const loadWorkbookData = (data: Record<string, unknown>) => {
    try {
      univerAPI.createUniverSheet(data);
    } catch {
      // Non-fatal: workbook stays in current state
    }
  };

  // --- Snapshot controller ---
  const snapshotController = createSnapshotController(
    db,
    workbookId,
    workspaceId,
    clientId,
    getWorkbookData,
    (snap) => {
      loadWorkbookData(snap.data as Record<string, unknown>);
    },
  );

  // Load latest snapshot on startup
  const latestSnapshot = await snapshotController.loadLatest().catch(() => null);
  if (latestSnapshot?.data) {
    loadWorkbookData(latestSnapshot.data as Record<string, unknown>);
  }

  // --- Collab controller ---
  let lastMutationTs: string | null = latestSnapshot?.mutation_watermark ?? null;

  const collabController = createCollabController(
    db,
    workbookId,
    workspaceId,
    clientId,
    (cmd) => {
      // Replay remote mutation via Univer command service
      try {
        // Access internal command service through the facade layer
        const commandService = (univerAPI as unknown as {
          _commandService?: {
            executeCommand(
              id: string,
              params: Record<string, unknown>,
              opts: { fromCollab: boolean },
            ): Promise<boolean>;
          };
        })._commandService;

        if (commandService) {
          void commandService.executeCommand(cmd.command_id, cmd.params, { fromCollab: true });
        }
      } catch {
        // Skip — collab controller has already logged to client_error
      }
      snapshotController.onMutationApplied();
      lastMutationTs = new Date().toISOString();
    },
    () => {
      onSnapshotNeeded?.();
    },
    (count) => {
      onSyncWarning?.(`Mutation queue backed up: ${count} pending`);
    },
  );

  await collabController.start();

  // Capture local mutations and broadcast them to SurrealDB
  univerAPI.addEvent(univerAPI.Event.CommandExecuted, (event) => {
    const { id, params, type, options } = event as {
      id: string;
      params: Record<string, unknown>;
      type: number;
      options?: { fromCollab?: boolean };
    };

    if (!shouldBroadcastCommand(id, type, options?.fromCollab ?? false)) {
      return;
    }

    // INSERT with SurrealQL object syntax (per SurrealDB JS SDK v2 rules)
    void db
      .query(
        `INSERT INTO mutation { workbook: $wb, workspace: $ws, command_id: $cmd, params: $params, client_id: $cid }`,
        { wb: workbookId, ws: workspaceId, cmd: id, params, cid: clientId },
      )
      .catch(() => undefined);

    snapshotController.onMutationApplied();
    lastMutationTs = new Date().toISOString();
  });

  // --- Presence heartbeat + coordinator election ---
  const stopHeartbeat = startPresenceHeartbeat(db, workspaceId, workbookId, clientId);

  const stopWatchCoordinator = await watchCoordinator(
    db,
    workbookId,
    clientId,
    (isCoordinator) => snapshotController.setCoordinator(isCoordinator),
  ).catch(() => () => undefined);

  // Start snapshot watcher (coordinator role is set by watchCoordinator above)
  await snapshotController.start(false);

  // --- Reconnect handler ---
  const handleReconnect = async () => {
    const result = await collabController.handleReconnect(lastMutationTs);
    if (result === 'snapshot') {
      const fresh = await snapshotController.loadLatest().catch(() => null);
      if (fresh?.data) {
        loadWorkbookData(fresh.data as Record<string, unknown>);
      }
    }
  };

  db.subscribe('connected', () => {
    void handleReconnect();
  });

  return {
    destroy() {
      collabController.stop();
      snapshotController.stop();
      stopHeartbeat();
      stopWatchCoordinator();
      try {
        univer.dispose();
      } catch {
        // Ignore disposal errors
      }
    },

    getWorkbookData,
  };
}
