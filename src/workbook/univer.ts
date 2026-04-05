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
 * NOTE: Univer is loaded dynamically to avoid bundling its heavy CSS in tests
 * and in non-workbook routes.
 */
export async function bootstrapUniver(opts: UniverBootstrapOptions): Promise<UniverInstance> {
  const { db, workbookId, workspaceId, clientId, container, onSyncWarning, onSnapshotNeeded } = opts;

  // Dynamic import keeps Univer out of the critical path for other routes
  const { createUniver, UniverInstanceType } = await import('@univerjs/presets');
  const { UniverSheetsCorePreset } = await import('@univerjs/preset-sheets-core');

  const { univer, univerAPI } = createUniver({
    presets: [
      UniverSheetsCorePreset({
        container,
      }),
    ],
  });

  // Create an empty workbook; will be replaced by snapshot/entity data below
  let workbook = univerAPI.createUniverSheet({});

  // --- Snapshot controller ---
  const snapshotController = createSnapshotController(
    db,
    workbookId,
    workspaceId,
    clientId,
    () => {
      // Serialize current workbook state for snapshot
      try {
        const wb = univerAPI.getActiveWorkbook();
        if (!wb) {
          return {};
        }
        return (wb as unknown as { save(): Record<string, unknown> }).save() ?? {};
      } catch {
        return {};
      }
    },
    (snap) => {
      // Apply incoming snapshot from another coordinator
      try {
        univer.disposeUnit(workbook.id);
        workbook = univerAPI.createUniverSheet(snap.data as Record<string, unknown>);
      } catch {
        // Non-fatal: workbook stays in current state
      }
    },
  );

  // Load latest snapshot or fall back to entity table data
  const latestSnapshot = await snapshotController.loadLatest().catch(() => null);
  if (latestSnapshot?.data) {
    try {
      univer.disposeUnit(workbook.id);
      workbook = univerAPI.createUniverSheet(latestSnapshot.data as Record<string, unknown>);
    } catch {
      // Fall through — keep empty workbook
    }
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
        const commandService = (univerAPI as unknown as {
          getCommandService?(): {
            executeCommand(id: string, params: Record<string, unknown>, opts: { fromCollab: boolean }): Promise<boolean>;
          };
        }).getCommandService?.();

        if (commandService) {
          void commandService.executeCommand(cmd.command_id, cmd.params, { fromCollab: true });
        }
      } catch {
        // Skip — logged to client_error by the collab controller
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

  // Capture local mutations and broadcast them
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

    void db
      .query(
        `INSERT INTO mutation (workbook, workspace, command_id, params, client_id) VALUES ($wb, $ws, $cmd, $params, $cid)`,
        {
          wb: workbookId,
          ws: workspaceId,
          cmd: id,
          params,
          cid: clientId,
        },
      )
      .catch(() => {
        // Retry logic handled inside CollabController; this path is best-effort direct insert
      });

    snapshotController.onMutationApplied();
    lastMutationTs = new Date().toISOString();
  });

  // --- Presence + coordinator election ---
  const stopHeartbeat = startPresenceHeartbeat(db, workspaceId, workbookId, clientId);

  const stopWatchCoordinator = await watchCoordinator(
    db,
    workbookId,
    clientId,
    (isCoordinator) => {
      snapshotController.setCoordinator(isCoordinator);
    },
  ).catch(() => () => undefined);

  await snapshotController.start(false); // coordinator role will be set by watchCoordinator callback

  // Handle reconnection
  const handleReconnect = async () => {
    const result = await collabController.handleReconnect(lastMutationTs);
    if (result === 'snapshot') {
      const fresh = await snapshotController.loadLatest().catch(() => null);
      if (fresh?.data) {
        try {
          univer.disposeUnit(workbook.id);
          workbook = univerAPI.createUniverSheet(fresh.data as Record<string, unknown>);
        } catch {
          // Best effort
        }
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
        // Ignore cleanup errors
      }
    },

    getWorkbookData(): Record<string, unknown> {
      try {
        const wb = univerAPI.getActiveWorkbook();
        if (!wb) {
          return {};
        }
        return (wb as unknown as { save(): Record<string, unknown> }).save() ?? {};
      } catch {
        return {};
      }
    },
  };
}
