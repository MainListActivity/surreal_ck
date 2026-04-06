import type { IWorksheetData } from '@univerjs/core';
import type { Surreal } from 'surrealdb';

import type { Sheet } from '../lib/surreal/types';
import { createCollabController, shouldBroadcastCommand } from './collaboration';
import { startPresenceHeartbeat, watchCoordinator } from './presence';
import { createSnapshotController } from './snapshot';

export interface UniverBootstrapOptions {
  db: Surreal;
  workbookId: string;
  workspaceId: string;
  clientId: string;
  container: HTMLElement;
  /** Pre-loaded sheet records from SurrealDB. If provided, Univer will be
   *  initialised with these tabs instead of an empty workbook. */
  sheets?: Sheet[];
  /** Workspace key used for table-name generation (e.g. "harbor"). */
  wsKey?: string;
  /** Called when the user adds a new tab inside Univer. */
  onSheetAdded?: (univerId: string, label: string) => void;
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
  const {
    db,
    workbookId,
    workspaceId,
    clientId,
    container,
    onSyncWarning,
    onSnapshotNeeded,
  } = opts;

  const { createUniver } = await import('@univerjs/presets');
  const { UniverSheetsCorePreset } = await import('@univerjs/preset-sheets-core');

  const { univer, univerAPI } = createUniver({
    presets: [
      UniverSheetsCorePreset({
        container,
      }),
    ],
  });

  // ── Create workbook: use pre-loaded sheets or empty workbook ────────────────
  if (opts.sheets && opts.sheets.length > 0) {
    univerAPI.createUniverSheet({
      id: workbookId,
      sheets: opts.sheets.reduce<Record<string, Partial<IWorksheetData>>>((acc, s) => {
        acc[s.univer_id] = {
          id: s.univer_id,
          name: s.label,
          rowCount: 1000,
          columnCount: 26,
        };
        return acc;
      }, {}),
      sheetOrder: [...opts.sheets]
        .sort((a, b) => a.position - b.position)
        .map((s) => s.univer_id),
    });
  } else {
    // Create an empty workbook as starting point
    univerAPI.createUniverSheet({});
  }

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
    clientId,
    getWorkbookData,
    (snap) => {
      loadWorkbookData(snap.layout as Record<string, unknown>);
    },
  );

  // Load latest snapshot on startup
  const latestSnapshot = await snapshotController.loadLatest().catch(() => null);
  if (latestSnapshot?.layout) {
    loadWorkbookData(latestSnapshot.layout as Record<string, unknown>);
  }

  // ── Populate cells from entity tables (Step 9) ──────────────────────────────
  // Map: sheetUniverId → (rowIndex → recordId)
  const rowOrderMap = new Map<string, Map<number, string>>();

  if (opts.sheets && opts.sheets.length > 0) {
    for (const sheet of opts.sheets) {
      const [rows] = await db
        .query<[Array<Record<string, unknown>>]>(
          `SELECT * FROM type::table($tbl) ORDER BY created_at ASC LIMIT 500`,
          { tbl: sheet.table_name },
        )
        .catch(() => [[]] as [Array<Record<string, unknown>>]);

      if (!rows?.length) continue;

      const wb = univerAPI.getActiveWorkbook();
      if (!wb) continue;
      const univerSheet = wb.getSheetBySheetId(sheet.univer_id);
      if (!univerSheet) continue;

      const colDefs = (sheet.column_defs ?? []) as Array<{ key: string; label: string }>;

      // Write column headers
      if (colDefs.length > 0) {
        colDefs.forEach((col, colIdx) => {
          univerSheet.getRange(0, colIdx, 1, 1).setValue(col.label);
        });
      }

      // Write row data and build row-index → record-id map
      rows.forEach((row, rowIdx) => {
        const dataRowIdx = rowIdx + (colDefs.length > 0 ? 1 : 0);

        if (!rowOrderMap.has(sheet.univer_id)) {
          rowOrderMap.set(sheet.univer_id, new Map());
        }
        rowOrderMap.get(sheet.univer_id)!.set(dataRowIdx, String(row.id));

        if (colDefs.length > 0) {
          colDefs.forEach((col, colIdx) => {
            const val = row[col.key];
            if (val !== undefined && val !== null) {
              univerSheet.getRange(dataRowIdx, colIdx, 1, 1).setValue(String(val));
            }
          });
        } else {
          // No column defs — write all non-system fields as columns
          const fields = Object.entries(row).filter(
            ([k]) => !['id', 'workspace', 'created_at', 'updated_at'].includes(k),
          );
          fields.forEach(([, val], colIdx) => {
            if (val !== undefined && val !== null) {
              univerSheet.getRange(dataRowIdx, colIdx, 1, 1).setValue(String(val));
            }
          });
        }
      });
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

  // ── Capture local mutations: cell edits go to entity table; layout/style
  //    mutations go to collab mutation log ────────────────────────────────────
  univerAPI.addEvent(univerAPI.Event.CommandExecuted, (event) => {
    const { id, params, type, options } = event as {
      id: string;
      params: Record<string, unknown>;
      type: number;
      options?: { fromCollab?: boolean };
    };

    // ── Step 10: handle cell value mutations directly to entity table ──────
    if (id === 'sheet.mutation.set-range-values-mutation' && !options?.fromCollab) {
      const subUnitId = (params as Record<string, unknown>).subUnitId as string;
      const cellMatrix = (params as Record<string, unknown>).cellValue as
        | Record<string, Record<string, { v?: unknown }>>
        | undefined;
      const targetSheet = opts.sheets?.find((s) => s.univer_id === subUnitId);
      const colDefs = (targetSheet?.column_defs ?? []) as Array<{ key: string; label: string }>;
      const rowMap = rowOrderMap.get(subUnitId);

      if (targetSheet && cellMatrix) {
        for (const [rowIdxStr, cols] of Object.entries(cellMatrix)) {
          const rowIdx = parseInt(rowIdxStr, 10);
          const existingId = rowMap?.get(rowIdx) ?? null;
          const fields: Record<string, unknown> = {};

          for (const [colIdxStr, cell] of Object.entries(cols)) {
            const colIdx = parseInt(colIdxStr, 10);
            const fieldKey = colDefs[colIdx]?.key ?? `col_${colIdx}`;
            fields[fieldKey] = cell.v ?? '';
          }

          void db
            .query(
              existingId
                ? `UPDATE $id MERGE $fields SET updated_at = time::now()`
                : `INSERT INTO type::table($tbl) $fields RETURN id`,
              existingId
                ? { id: existingId, fields }
                : { tbl: targetSheet.table_name, fields: { ...fields, workspace: workspaceId } },
            )
            .then((result) => {
              if (!existingId && result?.[0]) {
                const firstRow = (result[0] as unknown[])[0];
                if (firstRow && typeof firstRow === 'object' && 'id' in firstRow) {
                  const newId = String((firstRow as { id: unknown }).id);
                  if (!rowOrderMap.has(subUnitId)) rowOrderMap.set(subUnitId, new Map());
                  rowOrderMap.get(subUnitId)!.set(rowIdx, newId);
                }
              }
            })
            .catch(() => {
              onSyncWarning?.('Cell save failed — changes may not be persisted.');
            });
        }
      }
      // Do NOT write cell values to collab mutation log
      return;
    }

    // ── New sheet tab created inside Univer ────────────────────────────────
    if (id === 'sheet.mutation.insert-sheet-mutation') {
      const sheetParams = params as Record<string, unknown>;
      const unitId = sheetParams.unitId as string | undefined;
      const name = sheetParams.name as string | undefined;
      if (unitId && name) {
        opts.onSheetAdded?.(unitId, name);
      }
      // Fall through so the structural mutation is also broadcast to collab
    }

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
  const stopHeartbeat = startPresenceHeartbeat(db, workbookId, clientId);

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
      if (fresh?.layout) {
        loadWorkbookData(fresh.layout as Record<string, unknown>);
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
