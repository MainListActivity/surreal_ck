import { describe, expect, test } from "bun:test";
import type { SurrealConn, SurrealTransactionWriter } from "./surreal";
import { createImportBatchUndoService } from "./import-batch-undo";

function harness(options: { canDelete?: boolean; externalReference?: boolean } = {}) {
  let target = { id: "ent_claim:a", updated_at: "2026-09-22T10:00:00Z" } as Record<string, unknown> | null;
  let undo: Record<string, unknown> | null = null;
  let batchStatus = "completed";

  const execute = async (sql: string, bindings?: Record<string, unknown>) => {
    if (/FROM import_batch_undo/i.test(sql)) return undo ? [{ ...undo }] : [];
    if (/FROM import_batch WHERE/i.test(sql)) return [{ status: batchStatus }];
    if (/FROM import_batch_row/i.test(sql)) {
      return [{ target_record: "ent_claim:a", target_updated_at: "2026-09-22T10:00:00Z" }];
    }
    if (/FROM sheet/i.test(sql)) {
      return options.externalReference ? [{
        table_name: "ent_note",
        column_defs: [{ key: "claim", field_type: "reference", reference_table: "ent_claim", reference_multiple: false }],
      }] : [];
    }
    if (/SELECT id FROM ent_note/i.test(sql)) return [{ id: "ent_note:outside" }];
    if (/SELECT id, updated_at FROM \$target/i.test(sql)) return target ? [{ ...target }] : [];
    if (/DELETE \$target/i.test(sql)) {
      if (options.canDelete === false || !target) return [];
      const deleted = { ...target };
      target = null;
      return [deleted];
    }
    if (/CREATE import_batch_undo/i.test(sql)) {
      undo = {
        deleted_count: bindings?.deletedCount,
        target_records: bindings?.targetRecords,
        created_at: "2026-09-22T10:05:00Z",
      };
      return [{ ...undo }];
    }
    if (/UPDATE \$batch SET status = "undone"/i.test(sql)) {
      batchStatus = "undone";
      return [];
    }
    return [];
  };

  const conn = {
    query: execute,
    transaction: async (run: (tx: SurrealTransactionWriter) => Promise<unknown>) => {
      const beforeTarget = target ? { ...target } : null;
      const beforeUndo = undo ? { ...undo } : null;
      const beforeStatus = batchStatus;
      try {
        return await run({ query: execute } as SurrealTransactionWriter);
      } catch (cause) {
        target = beforeTarget;
        undo = beforeUndo;
        batchStatus = beforeStatus;
        throw cause;
      }
    },
  } as unknown as SurrealConn;

  return {
    conn,
    edit() { if (target) target.updated_at = "2026-09-22T10:02:00Z"; },
    get target() { return target; },
    get batchStatus() { return batchStatus; },
  };
}

describe("导入批次撤销公开接口", () => {
  test("预检后原子删除并保留回执，重复撤销返回既有结果", async () => {
    const h = harness();
    const service = createImportBatchUndoService(h.conn);
    const preview = await service.preview("import_batch:b1");

    expect(preview).toMatchObject({ status: "ready", deletableCount: 1, blockers: [] });
    expect(h.target).not.toBeNull();
    expect(await service.undo("import_batch:b1", preview.token)).toMatchObject({ status: "undone", deletedCount: 1 });
    expect(h.target).toBeNull();
    expect(h.batchStatus).toBe("undone");
    expect(await service.undo("import_batch:b1", preview.token)).toMatchObject({ status: "already_undone", deletedCount: 1 });
  });

  test("确认前并发编辑会整体冲突且不删除记录", async () => {
    const h = harness();
    const service = createImportBatchUndoService(h.conn);
    const preview = await service.preview("import_batch:b1");
    h.edit();

    const result = await service.undo("import_batch:b1", preview.token);

    expect(result.status).toBe("conflict");
    expect(result.conflict?.blockers[0]?.kind).toBe("edited");
    expect(h.target).not.toBeNull();
  });

  test("批次外引用与删除权限不足都会阻止预检", async () => {
    const external = await createImportBatchUndoService(harness({ externalReference: true }).conn)
      .preview("import_batch:b1");
    const denied = await createImportBatchUndoService(harness({ canDelete: false }).conn)
      .preview("import_batch:b1");

    expect(external.blockers.some((blocker) => blocker.kind === "external_reference")).toBe(true);
    expect(denied.blockers.some((blocker) => blocker.kind === "permission_denied")).toBe(true);
  });
});
