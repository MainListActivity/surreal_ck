import { importFingerprint } from "./import-batch";
import { recordValueToString, toRecordId } from "./record-id";
import type { SurrealConn, SurrealTransactionWriter } from "./surreal";

const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const PROBE_ROLLBACK = Symbol("import-undo-permission-probe");

export type ImportUndoBlocker = {
  kind: "edited" | "missing" | "external_reference" | "permission_denied" | "unverified";
  targetRecordId: string;
  message: string;
  referencingRecordId?: string;
};

export type ImportUndoPreview = {
  batchId: string;
  status: "ready" | "blocked" | "already_undone";
  deletableCount: number;
  targetRecordIds: string[];
  blockers: ImportUndoBlocker[];
  token: string;
  undoneAt: string | null;
};

export type ImportUndoResult = {
  status: "undone" | "already_undone" | "conflict";
  deletedCount: number;
  targetRecordIds: string[];
  conflict?: ImportUndoPreview;
};

type QueryWriter = Pick<SurrealConn, "query"> | Pick<SurrealTransactionWriter, "query">;

type StoredReceipt = {
  target_record?: unknown;
  target_updated_at?: unknown;
};

type StoredUndo = {
  deleted_count?: unknown;
  target_records?: unknown;
  created_at?: unknown;
};

type StoredSheet = {
  table_name?: unknown;
  column_defs?: Array<{
    key?: unknown;
    field_type?: unknown;
    reference_table?: unknown;
    reference_multiple?: unknown;
  }>;
};

export function createImportBatchUndoService(conn: SurrealConn) {
  async function preview(batchId: string): Promise<ImportUndoPreview> {
    const existing = await loadUndo(conn, batchId);
    if (existing) return completedPreview(batchId, existing);
    const inspected = await inspectUndo(conn, batchId);
    if (inspected.blockers.length) return toPreview(batchId, inspected);

    try {
      await conn.transaction(async (tx) => {
        for (const target of inspected.targets) {
          const deleted = await tx.query("DELETE $target RETURN BEFORE", { target: toRecordId(target.id) });
          if (deleted.length !== 1) throw new Error(`无权删除导入记录 ${target.id}`);
        }
        throw PROBE_ROLLBACK;
      });
    } catch (cause) {
      if (cause !== PROBE_ROLLBACK) {
        inspected.blockers.push({
          kind: "permission_denied",
          targetRecordId: inspected.targets[0]?.id ?? batchId,
          message: cause instanceof Error ? cause.message : "调用者没有删除全部导入记录的权限",
        });
      }
    }
    return toPreview(batchId, inspected);
  }

  async function undo(batchId: string, expectedToken: string): Promise<ImportUndoResult> {
    const existing = await loadUndo(conn, batchId);
    if (existing) return completedResult("already_undone", existing);

    try {
      return await conn.transaction(async (tx) => {
        const repeated = await loadUndo(tx, batchId);
        if (repeated) return completedResult("already_undone", repeated);
        const inspected = await inspectUndo(tx, batchId);
        const current = toPreview(batchId, inspected);
        if (current.status !== "ready" || current.token !== expectedToken) {
          throw new ImportUndoConflict(current);
        }
        for (const target of inspected.targets) {
          const deleted = await tx.query("DELETE $target RETURN BEFORE", { target: toRecordId(target.id) });
          if (deleted.length !== 1) {
            current.blockers.push({
              kind: "permission_denied",
              targetRecordId: target.id,
              message: `记录 ${target.id} 未删除，可能权限或并发状态已变化`,
            });
            current.status = "blocked";
            throw new ImportUndoConflict(current);
          }
        }
        const targetRecords = inspected.targets.map((target) => toRecordId(target.id));
        const receipts = await tx.query<StoredUndo>(
          `CREATE import_batch_undo CONTENT {
            batch: $batch,
            status: "completed",
            deleted_count: $deletedCount,
            target_records: $targetRecords
          } RETURN AFTER`,
          { batch: toRecordId(batchId), deletedCount: targetRecords.length, targetRecords },
        );
        const receipt = receipts[0];
        if (!receipt) throw new Error("撤销完成后未返回审计回执");
        await tx.query('UPDATE $batch SET status = "undone", completed_at = time::now()', {
          batch: toRecordId(batchId),
        });
        return completedResult("undone", receipt);
      });
    } catch (cause) {
      if (cause instanceof ImportUndoConflict) {
        return {
          status: "conflict",
          deletedCount: 0,
          targetRecordIds: [],
          conflict: cause.preview,
        };
      }
      throw cause;
    }
  }

  return { preview, undo };
}

class ImportUndoConflict extends Error {
  constructor(readonly preview: ImportUndoPreview) {
    super("导入记录在确认撤销前发生变化");
  }
}

async function inspectUndo(writer: QueryWriter, batchId: string) {
  const batches = await writer.query<{ status?: unknown }>(
    "SELECT status FROM import_batch WHERE id = $batch LIMIT 1",
    { batch: toRecordId(batchId) },
  );
  const batchStatus = optionalString(batches[0]?.status);
  const blockers: ImportUndoBlocker[] = [];
  if (!batchStatus) {
    blockers.push({ kind: "missing", targetRecordId: batchId, message: "导入批次不存在或不可见" });
  } else if (batchStatus === "processing" || batchStatus === "outcome_unknown") {
    blockers.push({ kind: "unverified", targetRecordId: batchId, message: "批次结果尚未核实，暂不可撤销" });
  }
  const receiptRows = await writer.query<StoredReceipt>(
    `SELECT target_record, target_updated_at FROM import_batch_row
      WHERE batch = $batch AND status = "success" AND target_record != NONE
      ORDER BY target_record ASC`,
    { batch: toRecordId(batchId) },
  );
  const targets = receiptRows.map((row) => ({
    id: recordValueToString(row.target_record) ?? "",
    importedUpdatedAt: optionalString(row.target_updated_at),
    currentUpdatedAt: null as string | null,
  })).filter((target) => target.id.includes(":"));
  const targetIds = new Set(targets.map((target) => target.id));
  if (targets.length === 0) {
    blockers.push({ kind: "missing", targetRecordId: batchId, message: "该批次没有可撤销的成功新增记录" });
  }
  for (const target of targets) {
    const current = await writer.query<{ id?: unknown; updated_at?: unknown }>(
      "SELECT id, updated_at FROM $target",
      { target: toRecordId(target.id) },
    );
    if (!current[0]) {
      blockers.push({ kind: "missing", targetRecordId: target.id, message: "导入记录已不存在" });
      continue;
    }
    target.currentUpdatedAt = optionalString(current[0].updated_at);
    if (!target.importedUpdatedAt || target.currentUpdatedAt !== target.importedUpdatedAt) {
      blockers.push({ kind: "edited", targetRecordId: target.id, message: "导入后记录已被修改" });
    }
  }

  const sheets = await writer.query<StoredSheet>("SELECT table_name, column_defs FROM sheet");
  for (const sheet of sheets) {
    const sourceTable = String(sheet.table_name ?? "");
    if (!SAFE_IDENTIFIER.test(sourceTable)) continue;
    for (const column of sheet.column_defs ?? []) {
      if (column.field_type !== "reference") continue;
      const field = String(column.key ?? "");
      const referenceTable = String(column.reference_table ?? "");
      if (!SAFE_IDENTIFIER.test(field) || !SAFE_IDENTIFIER.test(referenceTable)) continue;
      for (const target of targets.filter((candidate) => candidate.id.startsWith(`${referenceTable}:`))) {
        const predicate = column.reference_multiple === true
          ? `$target INSIDE ${field}`
          : `${field} = $target`;
        const references = await writer.query<{ id?: unknown }>(
          `SELECT id FROM ${sourceTable} WHERE ${predicate} LIMIT 20`,
          { target: toRecordId(target.id) },
        );
        for (const reference of references) {
          const referencingRecordId = recordValueToString(reference.id);
          if (!referencingRecordId || targetIds.has(referencingRecordId)) continue;
          blockers.push({
            kind: "external_reference",
            targetRecordId: target.id,
            referencingRecordId,
            message: `记录被批次外记录 ${referencingRecordId} 引用`,
          });
        }
      }
    }
  }

  return { targets, blockers };
}

function toPreview(
  batchId: string,
  inspected: Awaited<ReturnType<typeof inspectUndo>>,
): ImportUndoPreview {
  const targetRecordIds = inspected.targets.map((target) => target.id);
  return {
    batchId,
    status: inspected.blockers.length ? "blocked" : "ready",
    deletableCount: inspected.blockers.length ? 0 : targetRecordIds.length,
    targetRecordIds,
    blockers: [...inspected.blockers],
    token: importFingerprint({
      targets: inspected.targets,
      blockers: inspected.blockers.map((blocker) => ({ ...blocker })),
    }),
    undoneAt: null,
  };
}

async function loadUndo(writer: QueryWriter, batchId: string): Promise<StoredUndo | null> {
  const rows = await writer.query<StoredUndo>(
    "SELECT deleted_count, target_records, created_at FROM import_batch_undo WHERE batch = $batch LIMIT 1",
    { batch: toRecordId(batchId) },
  );
  return rows[0] ?? null;
}

function completedPreview(batchId: string, undo: StoredUndo): ImportUndoPreview {
  const result = completedResult("already_undone", undo);
  return {
    batchId,
    status: "already_undone",
    deletableCount: 0,
    targetRecordIds: result.targetRecordIds,
    blockers: [],
    token: "",
    undoneAt: optionalString(undo.created_at),
  };
}

function completedResult(
  status: "undone" | "already_undone",
  undo: StoredUndo,
): ImportUndoResult {
  return {
    status,
    deletedCount: Number(undo.deleted_count ?? 0),
    targetRecordIds: Array.isArray(undo.target_records)
      ? undo.target_records.map(recordValueToString).filter((id): id is string => Boolean(id))
      : [],
  };
}

function optionalString(value: unknown): string | null {
  return value == null ? null : String(value);
}
