import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { StringRecordId, Surreal } from "surrealdb";
import { createImportBatchService } from "./import-batch";
import { createImportBatchUndoService } from "./import-batch-undo";
import { openDataTableRuntime } from "./data-table-runtime";
import { createBrowserConn, type SurrealConn } from "./surreal";
import type { TemplateImportMapping } from "./template-sheet-import";

const localSurrealTest = test.skipIf(process.env.RUN_LOCAL_SURREALDB_IMPORT_TESTS !== "1");
const opened: Surreal[] = [];

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((db) => db.close()));
});

describe("导入批次真实 SurrealDB 契约", () => {
  localSurrealTest("重复提交同一批次源行只保留一条业务记录和一条成功回执", async () => {
    const db = new Surreal();
    opened.push(db);
    const database = `import_batch_${Date.now().toString(36)}`;
    await db.connect(process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:18080/rpc", {
      authentication: {
        username: process.env.LOCAL_SURREAL_ROOT_USER ?? "root",
        password: process.env.LOCAL_SURREAL_ROOT_PASS ?? "root",
      },
    });
    const namespace = process.env.LOCAL_SURREAL_NS ?? "main";
    await db.query(`DEFINE NAMESPACE IF NOT EXISTS ${namespace}; USE NS ${namespace}; DEFINE DATABASE ${database};`).collect();
    await db.use({ namespace, database });
    const migration = await readFile(
      new URL("../../../shared/sql/workspace-template/023-import-batch-recovery.surql", import.meta.url),
      "utf8",
    );
    const undoMigration = await readFile(
      new URL("../../../shared/sql/workspace-template/024-import-batch-undo.surql", import.meta.url),
      "utf8",
    );
    await db.query(`
      DEFINE TABLE user SCHEMAFULL PERMISSIONS FULL;
      DEFINE FIELD subject ON user TYPE string;
      DEFINE FIELD kind ON user TYPE string;
      DEFINE FIELD is_admin ON user TYPE bool DEFAULT false;
      DEFINE TABLE employee_credential SCHEMAFULL PERMISSIONS NONE;
      DEFINE FIELD employee ON employee_credential TYPE record<user>;
      DEFINE FIELD secret ON employee_credential TYPE string;
      DEFINE INDEX employee_credential_employee_unique ON employee_credential COLUMNS employee UNIQUE;
      DEFINE FUNCTION fn::current_user() { RETURN $auth.id; } PERMISSIONS FULL;
      DEFINE ACCESS employee_test ON DATABASE TYPE RECORD SIGNIN (
        SELECT * FROM user WHERE subject = $subject AND kind = "virtual"
          AND id = (SELECT VALUE employee FROM employee_credential WHERE secret = $pass LIMIT 1)[0]
      ) DURATION FOR SESSION 1h;
      CREATE user:tester CONTENT { subject: "tester", kind: "virtual", is_admin: false };
      CREATE employee_credential:tester CONTENT { employee: user:tester, secret: "test-pass" };
      CREATE user:admin CONTENT { subject: "admin", kind: "virtual", is_admin: true };
      CREATE employee_credential:admin CONTENT { employee: user:admin, secret: "admin-pass" };
      DEFINE TABLE workbook SCHEMAFULL PERMISSIONS FULL;
      DEFINE FIELD name ON workbook TYPE string;
      DEFINE TABLE sheet SCHEMAFULL PERMISSIONS FULL;
      DEFINE FIELD workbook ON sheet TYPE record<workbook>;
      DEFINE FIELD label ON sheet TYPE string;
      DEFINE FIELD table_name ON sheet TYPE string;
      DEFINE FIELD column_defs ON sheet TYPE any;
      DEFINE TABLE ent_claim SCHEMAFULL CHANGEFEED 7d
        PERMISSIONS
          FOR select, create, update WHERE $auth != NONE,
          FOR delete WHERE $auth.is_admin = true;
      DEFINE FIELD name ON ent_claim TYPE string;
      DEFINE FIELD amount ON ent_claim TYPE decimal;
      DEFINE FIELD updated_at ON ent_claim TYPE datetime VALUE time::now();
      DEFINE TABLE ent_note SCHEMAFULL
        PERMISSIONS
          FOR select, create, update WHERE $auth != NONE,
          FOR delete WHERE $auth.is_admin = true;
      DEFINE FIELD claim ON ent_note TYPE record<ent_claim>;
      CREATE workbook:w SET name = "测试台账";
      CREATE sheet:s SET workbook = workbook:w, label = "债权", table_name = "ent_claim", column_defs = [
        { key: "name", label: "名称", field_type: "text", required: true },
        { key: "amount", label: "金额", field_type: "decimal" }
      ];
      CREATE sheet:notes SET workbook = workbook:w, label = "备注", table_name = "ent_note", column_defs = [
        { key: "claim", label: "债权", field_type: "reference", reference_table: "ent_claim", reference_multiple: false }
      ];
      ${migration}
      ${undoMigration}
    `).collect();

    const member = new Surreal();
    opened.push(member);
    await member.connect(process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:18080/rpc", { namespace, database });
    await member.signin({
      namespace,
      database,
      access: "employee_test",
      variables: { subject: "tester", pass: "test-pass" },
    });
    await expect(member.query("DEFINE TABLE forbidden_by_record_access").collect()).rejects.toThrow();
    const conn = createBrowserConn(member as never) as SurrealConn;
    const batchService = createImportBatchService(conn);
    const batch = await batchService.start({
      fileName: "台账.csv",
      fileDigest: "digest",
      mappingVersion: "mapping",
      mode: "existing_tables",
      workbookId: "workbook:w",
      sheets: [{
        sheetName: "债权",
        targetSheetId: "sheet:s",
        mappings: [{ sourceIndex: 0, sourceLabel: "名称", targetKey: "name", matchedBy: "field-name" }],
      }],
    });
    const runtime = await openDataTableRuntime({
      conn,
      workbookId: "workbook:w",
      dataTableId: "sheet:s",
      query: { filters: [], filterMode: "and", sorts: [], hiddenFields: [], groupBy: null },
    });
    const mappings: TemplateImportMapping[] = [
      { sourceIndex: 0, sourceLabel: "名称", targetKey: "name", matchedBy: "field-name" },
      { sourceIndex: 1, sourceLabel: "金额", targetKey: "amount", matchedBy: "field-name" },
    ];
    const input = {
      rows: [["甲", "100"]],
      rowNumbers: [8],
      mappings,
      batch: { id: batch.id, sheetName: "债权" },
    };

    expect(await runtime.importCsvRows(input)).toMatchObject({ importedCount: 1, replayedCount: 0 });
    expect(await runtime.importCsvRows(input)).toMatchObject({ importedCount: 1, replayedCount: 1 });
    await batchService.finishSheet(batch.id, "债权", {
      status: "completed",
      importedCount: 1,
      rejectedCount: 0,
    });
    await batchService.finish(batch.id, "completed");
    expect(await conn.query("SELECT * FROM ent_claim")).toHaveLength(1);
    expect(await conn.query("SELECT * FROM import_batch_row")).toHaveLength(1);
    expect((await batchService.load(batch.id))?.sheets[0]?.targetSheetId).toBe("sheet:s");
    await runtime.close();

    const undoAsMember = await createImportBatchUndoService(conn).preview(batch.id);
    expect(undoAsMember.blockers.some((blocker) => blocker.kind === "permission_denied")).toBe(true);

    const adminDb = new Surreal();
    opened.push(adminDb);
    await adminDb.connect(process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:18080/rpc", { namespace, database });
    await adminDb.signin({
      namespace,
      database,
      access: "employee_test",
      variables: { subject: "admin", pass: "admin-pass" },
    });
    const adminConn = createBrowserConn(adminDb as never) as SurrealConn;
    const undoService = createImportBatchUndoService(adminConn);
    const ready = await undoService.preview(batch.id);
    expect(ready).toMatchObject({ status: "ready", deletableCount: 1, blockers: [] });
    const targetId = ready.targetRecordIds[0]!;
    await adminConn.updateRecord(targetId, { name: "后续修改" });
    const concurrent = await undoService.undo(batch.id, ready.token);
    expect(concurrent.status).toBe("conflict");
    expect(await adminConn.query("SELECT * FROM ent_claim")).toHaveLength(1);

    const externalBatch = await batchService.start({
      fileName: "外部引用.csv",
      fileDigest: "external",
      mappingVersion: "mapping",
      mode: "existing_tables",
      sheets: [{ sheetName: "债权", targetSheetId: "sheet:s", mappings }],
    });
    const externalRuntime = await openDataTableRuntime({
      conn,
      workbookId: "workbook:w",
      dataTableId: "sheet:s",
      query: { filters: [], filterMode: "and", sorts: [], hiddenFields: [], groupBy: null },
    });
    await externalRuntime.importCsvRows({ ...input, rows: [["乙", "200"]], rowNumbers: [9], batch: { id: externalBatch.id, sheetName: "债权" } });
    await batchService.finish(externalBatch.id, "completed");
    const externalTarget = (await batchService.load(externalBatch.id))!.rows[0]!.targetRecordId!;
    await conn.createRecord("ent_note", { claim: new StringRecordId(externalTarget) });
    const externallyReferenced = await undoService.preview(externalBatch.id);
    expect(externallyReferenced.blockers.some((blocker) => blocker.kind === "external_reference")).toBe(true);
    await externalRuntime.close();

    const cleanBatch = await batchService.start({
      fileName: "可撤销.csv",
      fileDigest: "clean",
      mappingVersion: "mapping",
      mode: "existing_tables",
      sheets: [{ sheetName: "债权", targetSheetId: "sheet:s", mappings }],
    });
    const cleanRuntime = await openDataTableRuntime({
      conn,
      workbookId: "workbook:w",
      dataTableId: "sheet:s",
      query: { filters: [], filterMode: "and", sorts: [], hiddenFields: [], groupBy: null },
    });
    await cleanRuntime.importCsvRows({ ...input, rows: [["丙", "300"]], rowNumbers: [10], batch: { id: cleanBatch.id, sheetName: "债权" } });
    await batchService.finish(cleanBatch.id, "completed");
    const cleanPreview = await undoService.preview(cleanBatch.id);
    const undone = await undoService.undo(cleanBatch.id, cleanPreview.token);
    expect(undone).toMatchObject({ status: "undone", deletedCount: 1 });
    expect(await undoService.undo(cleanBatch.id, cleanPreview.token)).toMatchObject({ status: "already_undone", deletedCount: 1 });
    expect((await batchService.load(cleanBatch.id))?.status).toBe("undone");
    await cleanRuntime.close();
  }, 15_000);
});
