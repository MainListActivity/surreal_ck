import { afterEach, describe, expect, test } from "bun:test";
import { Surreal } from "surrealdb";
import { createEditorStore } from "./editor-store";
import { createBrowserConn, type SurrealConn } from "./surreal";
import { createWorkbooksStore } from "./workbooks";

const localSurrealTest = test.skipIf(process.env.RUN_LOCAL_SURREALDB_TESTS !== "1");
const opened: Surreal[] = [];

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((db) => db.close()));
});

async function setupDatabase(): Promise<{ conn: SurrealConn; inspector: Surreal }> {
  const url = process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
  const namespace = process.env.LOCAL_SURREAL_NS ?? "main";
  const database = `template_instantiation_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const authentication = {
    username: process.env.LOCAL_SURREAL_ROOT_USER ?? "root",
    password: process.env.LOCAL_SURREAL_ROOT_PASS ?? "root",
  };

  const inspector = new Surreal();
  opened.push(inspector);
  await inspector.connect(url, { authentication, namespace, database });
  await inspector.query(`
    DEFINE TABLE workbook_template SCHEMAFULL;
    DEFINE FIELD key ON TABLE workbook_template TYPE string;

    DEFINE TABLE workbook SCHEMAFULL;
    DEFINE FIELD name ON TABLE workbook TYPE string;
    DEFINE FIELD template ON TABLE workbook TYPE option<record<workbook_template>>;
    DEFINE FIELD last_opened_sheet ON TABLE workbook TYPE option<record<sheet>>;
    DEFINE FIELD created_at ON TABLE workbook TYPE datetime VALUE time::now() READONLY;
    DEFINE FIELD updated_at ON TABLE workbook TYPE datetime VALUE time::now();

    DEFINE TABLE sheet SCHEMAFULL;
    DEFINE FIELD workbook ON TABLE sheet TYPE record<workbook>;
    DEFINE FIELD label ON TABLE sheet TYPE string;
    DEFINE FIELD table_name ON TABLE sheet TYPE string;
    DEFINE FIELD column_defs ON TABLE sheet TYPE any DEFAULT [];
    DEFINE FIELD created_at ON TABLE sheet TYPE datetime VALUE time::now() READONLY;
    DEFINE FIELD updated_at ON TABLE sheet TYPE datetime VALUE time::now();
    DEFINE INDEX sheet_table_name_unique ON TABLE sheet COLUMNS table_name UNIQUE;

    DEFINE TABLE activity_event SCHEMALESS;
    CREATE workbook_template:claims CONTENT { key: "claims" };
  `).collect();

  const browser = new Surreal();
  opened.push(browser);
  const conn = createBrowserConn(browser as never);
  await conn.connect(url, { authentication, namespace, database });
  return { conn, inspector };
}

describe("OIP-02 多数据表模板实例化", () => {
  localSurrealTest("双数据表创建后编辑器可见、可切换并能分别读写记录", async () => {
    const { conn } = await setupDatabase();
    const workbooks = createWorkbooksStore({ getConn: () => conn });

    const workbook = await workbooks.createFromTemplate({
      id: "workbook_template:claims",
      defaultName: "破产债权台账",
      sheets: [
        {
          label: "债权人表",
          columns: [{ key: "creditor_name", label: "债权人名称", fieldType: "text", required: true }],
        },
        {
          label: "证据材料表",
          columns: [{ key: "material_name", label: "材料名称", fieldType: "text", required: true }],
        },
      ],
    });
    expect(workbook).not.toBeNull();

    const editor = createEditorStore({ getConn: () => conn });
    await editor.loadWorkbook(workbook!.id);
    expect(editor.sheets.map((sheet) => sheet.label)).toEqual(["债权人表", "证据材料表"]);
    expect(await editor.saveRows([{ values: { creditor_name: "甲公司" } }])).toBe(true);
    await editor.reloadRows();
    expect(editor.rows[0]?.values.creditor_name).toBe("甲公司");

    await editor.switchSheet(editor.sheets[1]!.id);
    expect(editor.columns.map((column) => column.key)).toEqual(["material_name"]);
    expect(await editor.saveRows([{ values: { material_name: "借款合同" } }])).toBe(true);
    await editor.reloadRows();
    expect(editor.rows[0]?.values.material_name).toBe("借款合同");
    editor.reset();
  }, 15_000);

  localSurrealTest("第二条数据表元数据创建失败时回滚工作簿、首表元数据和全部实体表", async () => {
    const { conn, inspector } = await setupDatabase();
    const keys = ["1111111111111111", "2222222222222222", "3333333333333333"];
    await inspector.query(`
      CREATE sheet:3333333333333333 CONTENT {
        workbook: workbook:placeholder,
        label: "预占记录",
        table_name: "reserved",
        column_defs: [],
      };
    `).collect();
    const workbooks = createWorkbooksStore({
      getConn: () => conn,
      generateKey: () => keys.shift()!,
    });

    const workbook = await workbooks.createFromTemplate({
      id: "workbook_template:claims",
      sheets: [
        { label: "债权人表", columns: [{ key: "name", label: "名称", fieldType: "text" }] },
        { label: "证据材料表", columns: [{ key: "title", label: "材料", fieldType: "text" }] },
      ],
    });

    expect(workbook).toBeNull();
    const records = await inspector.query<[
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>,
    ]>(`
      SELECT * FROM workbook:1111111111111111;
      SELECT * FROM sheet:2222222222222222;
    `).collect();
    expect(records[0]).toEqual([]);
    expect(records[1]).toEqual([]);
    const databaseInfo = await inspector.query<[Array<{ tables: Record<string, string> }>]>(
      "RETURN (INFO FOR DB).tables",
    ).collect();
    expect(JSON.stringify(databaseInfo)).not.toContain("ent_1111111111111111_2222222222222222");
    expect(JSON.stringify(databaseInfo)).not.toContain("ent_1111111111111111_3333333333333333");
  }, 15_000);

  localSurrealTest("旧单数据表模板仍创建 _main 实体表并可由编辑器读写", async () => {
    const { conn } = await setupDatabase();
    const workbooks = createWorkbooksStore({ getConn: () => conn });
    const workbook = await workbooks.createFromTemplate({
      id: "workbook_template:claims",
      columns: [{ key: "name", label: "名称", fieldType: "text", required: true }],
    });
    expect(workbook).not.toBeNull();

    const editor = createEditorStore({ getConn: () => conn });
    await editor.loadWorkbook(workbook!.id);
    expect(editor.sheets).toHaveLength(1);
    expect(editor.sheets[0]!.tableName).toMatch(/^ent_[0-9a-f]+_main$/);
    expect(await editor.saveRows([{ values: { name: "回归记录" } }])).toBe(true);
    await editor.reloadRows();
    expect(editor.rows[0]?.values.name).toBe("回归记录");
    editor.reset();
  }, 15_000);
});
