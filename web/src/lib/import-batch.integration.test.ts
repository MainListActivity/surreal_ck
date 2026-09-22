import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Surreal } from "surrealdb";
import { createImportBatchService } from "./import-batch";
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
          FOR delete NONE;
      DEFINE FIELD name ON ent_claim TYPE string;
      DEFINE FIELD amount ON ent_claim TYPE decimal;
      CREATE workbook:w SET name = "测试台账";
      CREATE sheet:s SET workbook = workbook:w, label = "债权", table_name = "ent_claim", column_defs = [
        { key: "name", label: "名称", field_type: "text", required: true },
        { key: "amount", label: "金额", field_type: "decimal" }
      ];
      ${migration}
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
    expect(await conn.query("SELECT * FROM ent_claim")).toHaveLength(1);
    expect(await conn.query("SELECT * FROM import_batch_row")).toHaveLength(1);
    expect((await batchService.load(batch.id))?.sheets[0]?.targetSheetId).toBe("sheet:s");
    await runtime.close();
  }, 15_000);
});
