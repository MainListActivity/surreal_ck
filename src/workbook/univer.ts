import { LocaleType, type IWorksheetData } from '@univerjs/core';
import { Table } from 'surrealdb';
import type { Surreal } from 'surrealdb';

import type { SidebarPanel } from '../features/workbook/mock-data';
import { toRecordId } from '../lib/surreal/record-id';
import type { Sheet } from '../lib/surreal/types';
import { createCollabController, shouldBroadcastCommand } from './collaboration';
import { startPresenceHeartbeat, watchCoordinator } from './presence';
import { createSnapshotController } from './snapshot';
import { mountUniverHeaderExtensions } from './univer-header';

export interface UniverBootstrapOptions {
  db: Surreal;
  workbookId: string;
  workspaceId: string;
  clientId: string;
  container: HTMLElement;
  /** AbortSignal to cancel bootstrap mid-flight (e.g. React StrictMode remount). */
  signal?: AbortSignal;
  /** Pre-loaded sheet records from SurrealDB. If provided, Univer will be
   *  initialised with these tabs instead of an empty workbook. */
  sheets?: Sheet[];
  /** Workspace key used for table-name generation (e.g. "harbor"). */
  wsKey?: string;
  /** Called when a Univer tab should be created or updated in the database. */
  onSheetUpsert?: (univerId: string, label: string) => void | Promise<void>;
  /** If provided, called on every CommandExecuted to get the current sheet list.
   *  Use this when the sheet list may change after bootstrap (e.g. new tabs added). */
  getSheets?: () => Sheet[];
  onSelectPanel?: (panel: SidebarPanel) => void;
  onSyncWarning?: (message: string) => void;
  onSnapshotNeeded?: () => void;
  /** Header bar extensions */
  workbookName?: string;
  displayName?: string;
  workbooks?: Array<{ id: string; name: string; updated_at?: string | null }>;
  activeWorkbookId?: string;
  onSelectWorkbook?: (id: string) => void;
  onShowAdmin?: () => void;
  onLogout?: () => void;
}

export interface UniverInstance {
  /** Tear down Univer and all collab subscriptions. */
  destroy(): void;
  /** Get current workbook data for snapshot serialization. */
  getWorkbookData(): Record<string, unknown>;
}

function getUniverLocale(): LocaleType {
  return LocaleType.ZH_CN;
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
    signal,
    onSyncWarning,
    onSnapshotNeeded,
  } = opts;

  const { createUniver } = await import('@univerjs/presets');
  const { UniverSheetsCorePreset } = await import('@univerjs/preset-sheets-core');
  const [enUS, zhCN] = await Promise.all([
    import('@univerjs/preset-sheets-core/locales/en-US'),
    import('@univerjs/preset-sheets-core/locales/zh-CN'),
  ]);

  // Check abort after async imports — avoids double-mounting on React StrictMode remount
  if (signal?.aborted) {
    throw new DOMException('Bootstrap aborted', 'AbortError');
  }

  const locale = getUniverLocale();

  const { univer, univerAPI } = createUniver({
    locale,
    locales: {
      [LocaleType.EN_US]: enUS.default,
      [LocaleType.ZH_CN]: zhCN.default,
    },
    presets: [
      UniverSheetsCorePreset({
        container,
        formulaBar: true,
        footer: {
          sheetBar: true,
          statisticBar: false,
          menus: true,
          zoomSlider: true,
        },
      }),
    ],
  });

  // ── Header bar extensions — slots are empty; top bar is owned by React shell ──
  mountUniverHeaderExtensions(univerAPI, {
    workbookName: opts.workbookName ?? '',
    displayName: opts.displayName,
    workbooks: opts.workbooks ?? [],
    activeWorkbookId: opts.activeWorkbookId,
    onSelectWorkbook: opts.onSelectWorkbook,
    onShowAdmin: opts.onShowAdmin,
    onLogout: opts.onLogout,
  });

  // ── Ribbon far-left: workbook switcher (ribbon.start.history) ──────────────
  if (opts.workbooks && opts.workbooks.length > 0 && opts.onSelectWorkbook) {
    const workbookSwitcher = univerAPI.createSubmenu({
      id: 'surreal-ck-workbook-switcher',
      title: opts.workbookName ?? '工作簿',
      tooltip: '切换工作簿',
    });

    for (const wb of opts.workbooks) {
      workbookSwitcher.addSubmenu(univerAPI.createMenu({
        id: `surreal-ck-workbook-${wb.id}`,
        title: wb.id === opts.activeWorkbookId ? `✓ ${wb.name}` : wb.name,
        action: () => opts.onSelectWorkbook?.(wb.id),
      }));
    }

    workbookSwitcher.appendTo('ribbon.start.history');
  }

  // ── Ribbon panel tools (ribbon.start.others) ─────────────────────────────
  if (opts.onSelectPanel) {
    const workspaceTools = univerAPI
      .createSubmenu({
        id: 'surreal-ck-workspace-tools',
        title: '工作区',
      })
      .addSubmenu(univerAPI.createMenu({
        id: 'surreal-ck-panel-record',
        title: '债权详情',
        action: () => opts.onSelectPanel?.('record'),
      }))
      .addSubmenu(univerAPI.createMenu({
        id: 'surreal-ck-panel-graph',
        title: '数据血缘',
        action: () => opts.onSelectPanel?.('graph'),
      }))
      .addSubmenu(univerAPI.createMenu({
        id: 'surreal-ck-panel-history',
        title: '最近操作',
        action: () => opts.onSelectPanel?.('history'),
      }))
      .addSubmenu(univerAPI.createMenu({
        id: 'surreal-ck-panel-review',
        title: '审核队列',
        action: () => opts.onSelectPanel?.('review'),
      }))
      .addSubmenu(univerAPI.createMenu({
        id: 'surreal-ck-panel-ai',
        title: 'AI 助手',
        action: () => opts.onSelectPanel?.('ai'),
      }))
      .addSubmenu(univerAPI.createMenu({
        id: 'surreal-ck-panel-admin',
        title: '管理工具',
        action: () => opts.onSelectPanel?.('admin'),
      }))
      .addSeparator()
      .addSubmenu(univerAPI.createMenu({
        id: 'surreal-ck-panel-hide',
        title: '收起侧栏',
        action: () => opts.onSelectPanel?.('none'),
      }));

    workspaceTools.appendTo('ribbon.start.others');
  }

  // ── Ribbon far-right: admin & user (ribbon.others.others) ────────────────
  {
    const adminMenu = univerAPI.createSubmenu({
      id: 'surreal-ck-admin-menu',
      title: opts.displayName ? `👤 ${opts.displayName}` : '账户',
      tooltip: '账户与管理',
    });

    if (opts.onShowAdmin) {
      adminMenu.addSubmenu(univerAPI.createMenu({
        id: 'surreal-ck-admin-open',
        title: '管理工具',
        action: () => opts.onShowAdmin?.(),
      }));
    }

    adminMenu.addSubmenu(univerAPI.createMenu({
      id: 'surreal-ck-share',
      title: '复制链接',
      tooltip: '复制工作簿链接到剪贴板',
      action: () => {
        void navigator.clipboard.writeText(window.location.href).catch(() => undefined);
      },
    }));

    if (opts.onLogout) {
      adminMenu.addSeparator().addSubmenu(univerAPI.createMenu({
        id: 'surreal-ck-logout',
        title: '退出登录',
        action: () => opts.onLogout?.(),
      }));
    }

    adminMenu.appendTo('ribbon.others.others');
  }

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

  // F2: Extract hydration into a named function so reconnect can call it too
  const hydrateEntityTables = async () => {
    if (!opts.sheets?.length) return;
    rowOrderMap.clear(); // reset before re-hydrating

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
  };

  // Run hydration at bootstrap
  await hydrateEntityTables();

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

  // F1: Track in-flight INSERT promises to prevent double-INSERT races on rapid edits
  const pendingInserts = new Map<string, Promise<string>>();
  // Dedupe: track cells already persisted via SheetEditEnded to avoid double-write
  // from the subsequent set-range-values-mutation CommandExecuted event.
  const recentEditKeys = new Set<string>();

  const queueSheetUpsert = (univerId?: string, label?: string) => {
    if (!univerId || !label) return;
    void Promise.resolve(opts.onSheetUpsert?.(univerId, label)).catch(() => {
      onSyncWarning?.('工作表同步失败，数据库中的 sheet 记录可能未更新。');
    });
  };

  // ── Shared helper: persist a single cell's field map to the entity table ──
  function persistCellFields(
    subUnitId: string,
    rowIdx: number,
    fields: Record<string, unknown>,
    tableName: string,
  ) {
    const pendingKey = `${subUnitId}:${rowIdx}`;
    const rowMap = rowOrderMap.get(subUnitId);
    const existingId = rowMap?.get(rowIdx) ?? null;

    if (existingId) {
      void db
        .query(`UPDATE $id MERGE $fields SET updated_at = time::now()`, { id: existingId, fields })
        .catch(() => {
          onSyncWarning?.('Cell save failed — changes may not be persisted.');
        });
    } else if (pendingInserts.has(pendingKey)) {
      // F1: Race guard — another INSERT is in-flight; chain an UPDATE off it
      void pendingInserts.get(pendingKey)!.then((createdId) => {
        void db
          .query(`UPDATE $id MERGE $fields SET updated_at = time::now()`, { id: createdId, fields })
          .catch(() => {
            onSyncWarning?.('Cell save failed — changes may not be persisted.');
          });
      });
    } else {
      const insertPromise = db
        .query<[Array<{ id: unknown }>]>(
          `INSERT INTO type::table($tbl) $fields RETURN id`,
          { tbl: tableName, fields: { ...fields, workspace: workspaceId } },
        )
        .then((result) => {
          const newId = String(
            (result[0]?.[0] as { id?: unknown } | undefined)?.id ?? '',
          );
          if (newId) {
            if (!rowOrderMap.has(subUnitId)) rowOrderMap.set(subUnitId, new Map());
            rowOrderMap.get(subUnitId)!.set(rowIdx, newId);
          }
          pendingInserts.delete(pendingKey);
          return newId;
        })
        .catch((err: unknown) => {
          pendingInserts.delete(pendingKey);
          onSyncWarning?.('Cell save failed — changes may not be persisted.');
          throw err;
        });
      pendingInserts.set(pendingKey, insertPromise);
    }
  }

  // ── SheetEditEnded: fires when the user manually finishes editing a cell ──
  // This covers the case where Univer routes the edit through rich-text-editing
  // (doc-level) rather than set-range-values-mutation (sheet-level), so the
  // CommandExecuted branch below would never fire.
  univerAPI.addEvent(univerAPI.Event.SheetEditEnded, (event) => {
    const { worksheet, row, column, isConfirm } = event as {
      worksheet: { getSheetId(): string; getRange(r: number, c: number, nr: number, nc: number): { getValue(): unknown } };
      row: number;
      column: number;
      isConfirm: boolean;
    };
    if (!isConfirm) return;

    const subUnitId = worksheet.getSheetId();
    const currentSheets = opts.getSheets?.() ?? opts.sheets ?? [];
    const targetSheet = currentSheets.find((s) => s.univer_id === subUnitId);
    if (!targetSheet) return;

    const colDefs = (targetSheet.column_defs ?? []) as Array<{ key: string; label: string }>;
    const headerOffset = colDefs.length > 0 ? 1 : 0;
    if (row < headerOffset) return;

    // Read the committed value from Univer
    const cellValue = worksheet.getRange(row, column, 1, 1).getValue();
    const fieldKey = colDefs[column]?.key ?? `col_${column}`;

    const dedupeKey = `${subUnitId}:${row}:${column}`;
    recentEditKeys.add(dedupeKey);
    // Clear dedupe flag after 500 ms — enough time for CommandExecuted to arrive
    setTimeout(() => recentEditKeys.delete(dedupeKey), 500);

    persistCellFields(subUnitId, row, { [fieldKey]: cellValue ?? '' }, targetSheet.table_name);
  });

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
      const currentSheets = opts.getSheets?.() ?? opts.sheets ?? [];
      const targetSheet = currentSheets.find((s) => s.univer_id === subUnitId);
      const colDefs = (targetSheet?.column_defs ?? []) as Array<{ key: string; label: string }>;

      if (targetSheet && cellMatrix) {
        for (const [rowIdxStr, cols] of Object.entries(cellMatrix)) {
          const rowIdx = parseInt(rowIdxStr, 10);

          // F9: skip header row — row 0 is headers when colDefs are present
          const headerOffset = colDefs.length > 0 ? 1 : 0;
          if (rowIdx < headerOffset) continue;

          const fields: Record<string, unknown> = {};
          let allDeduped = true;

          for (const [colIdxStr, cell] of Object.entries(cols)) {
            const colIdx = parseInt(colIdxStr, 10);
            const fieldKey = colDefs[colIdx]?.key ?? `col_${colIdx}`;
            fields[fieldKey] = cell.v ?? '';
            if (!recentEditKeys.has(`${subUnitId}:${rowIdx}:${colIdx}`)) {
              allDeduped = false;
            }
          }

          // Skip rows where every cell was already persisted by SheetEditEnded
          if (allDeduped) continue;

          persistCellFields(subUnitId, rowIdx, fields, targetSheet.table_name);
        }
      }
      // Do NOT write cell values to collab mutation log
      return;
    }

    // ── F7: New sheet tab created inside Univer ────────────────────────────
    if (id === 'sheet.mutation.insert-sheet-mutation' && !options?.fromCollab) {
      const sheetParams = params as Record<string, unknown>;
      const sheetData = sheetParams.sheet as Record<string, unknown> | undefined;
      const newSheetId =
        (sheetData?.id as string | undefined) ?? (sheetParams.sheetId as string | undefined);
      const newSheetName =
        (sheetData?.name as string | undefined) ?? (sheetParams.name as string | undefined);
      queueSheetUpsert(newSheetId, newSheetName);
      // Fall through so the structural mutation is also broadcast to collab
    }

    // Rename sheet tabs by stable Univer sheet id so the DB sheet record
    // follows the visible tab label after in-editor edits.
    if (id.includes('set-worksheet-name') && !options?.fromCollab) {
      const sheetParams = params as Record<string, unknown>;
      const renamedSheetId =
        (sheetParams.subUnitId as string | undefined)
        ?? (sheetParams.sheetId as string | undefined)
        ?? (sheetParams.id as string | undefined);
      const renamedSheetName =
        (sheetParams.name as string | undefined)
        ?? (sheetParams.title as string | undefined);
      queueSheetUpsert(renamedSheetId, renamedSheetName);
      // Fall through so the structural mutation is also broadcast to collab
    }

    if (!shouldBroadcastCommand(id, type, options?.fromCollab ?? false)) {
      return;
    }

    // INSERT with SurrealQL object syntax (per SurrealDB JS SDK v2 rules)
    void db
      .query(
        `INSERT INTO mutation { workbook: $wb, workspace: $ws, command_id: $cmd, params: $params, client_id: $cid }`,
        { wb: toRecordId(workbookId), ws: toRecordId(workspaceId), cmd: id, params, cid: clientId },
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

  // F6: LIVE SELECT per entity table → sync remote cell edits into Univer ──────
  const liveCleanups: Array<() => void> = [];

  if (opts.sheets?.length) {
    for (const sheet of opts.sheets) {
      const liveQuery = await db.live(new Table(sheet.table_name)).catch(() => null);
      if (!liveQuery) continue;

      const colDefs = (sheet.column_defs ?? []) as Array<{ key: string; label: string }>;

      const unsub = liveQuery.subscribe((message: {
        action: string;
        value: Record<string, unknown>;
      }) => {
        if (message.action !== 'UPDATE' && message.action !== 'CREATE') return;
        const row = message.value;
        const rowId = String(row.id ?? '');
        if (!rowId) return;

        const wb = univerAPI.getActiveWorkbook();
        if (!wb) return;
        const univerSheet = wb.getSheetBySheetId(sheet.univer_id);
        if (!univerSheet) return; // not continue — this is inside a callback

        // Find or assign row index from rowOrderMap
        const sheetRowMap = rowOrderMap.get(sheet.univer_id) ?? new Map<number, string>();
        let targetRowIdx: number | undefined;
        for (const [idx, id] of sheetRowMap.entries()) {
          if (id === rowId) {
            targetRowIdx = idx;
            break;
          }
        }

        if (targetRowIdx === undefined) {
          // New row from another client: append at next available row
          const headerOffset = colDefs.length > 0 ? 1 : 0;
          targetRowIdx = headerOffset + sheetRowMap.size;
          sheetRowMap.set(targetRowIdx, rowId);
          rowOrderMap.set(sheet.univer_id, sheetRowMap);
        }

        // Write cell values
        if (colDefs.length > 0) {
          colDefs.forEach((col, colIdx) => {
            const val = row[col.key];
            if (val !== undefined && val !== null) {
              univerSheet.getRange(targetRowIdx!, colIdx, 1, 1).setValue(String(val));
            }
          });
        } else {
          const fields = Object.entries(row).filter(
            ([k]) => !['id', 'workspace', 'created_at', 'updated_at'].includes(k),
          );
          fields.forEach(([, val], colIdx) => {
            if (val !== undefined && val !== null) {
              univerSheet.getRange(targetRowIdx!, colIdx, 1, 1).setValue(String(val));
            }
          });
        }
      });

      liveCleanups.push(unsub);
    }
  }

  // --- Reconnect handler ---
  // F2: call hydrateEntityTables after reloading snapshot on reconnect
  const handleReconnect = async () => {
    const result = await collabController.handleReconnect(lastMutationTs);
    if (result === 'snapshot') {
      const fresh = await snapshotController.loadLatest().catch(() => null);
      if (fresh?.layout) {
        loadWorkbookData(fresh.layout as Record<string, unknown>);
        await hydrateEntityTables(); // re-populate cells after snapshot reload
      }
    }
  };

  db.subscribe('connected', () => {
    void handleReconnect();
  });

  return {
    destroy() {
      liveCleanups.forEach((cleanup) => cleanup()); // F6: clean up LIVE SELECT subscriptions
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
