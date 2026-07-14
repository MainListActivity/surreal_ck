import { afterEach, describe, expect, test } from "bun:test";
import { Surreal } from "surrealdb";
import { createEditorStore } from "./editor-store";
import { searchReferenceCandidates } from "./reference-cache";
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

describe("OIP-03 模板内跨数据表引用", () => {
  localSurrealTest("引用选择器读取目标表记录并由编辑器写入正确的 RecordId", async () => {
    const { conn } = await setupDatabase();
    const keys = ["1111111111111111", "2222222222222222", "3333333333333333"];
    const workbooks = createWorkbooksStore({
      getConn: () => conn,
      generateKey: () => keys.shift()!,
    });
    const workbook = await workbooks.createFromTemplate({
      id: "workbook_template:claims",
      sheets: [
        {
          key: "creditors",
          label: "债权人表",
          columns: [{ key: "name", label: "名称", fieldType: "text", required: true }],
        },
        {
          key: "materials",
          label: "证据材料表",
          columns: [
            { key: "title", label: "材料名称", fieldType: "text", required: true },
            {
              key: "creditor",
              label: "关联债权人",
              fieldType: "reference",
              referenceSheetKey: "creditors",
            },
          ],
        },
      ],
    });
    expect(workbook).not.toBeNull();

    const editor = createEditorStore({ getConn: () => conn });
    await editor.loadWorkbook(workbook!.id);
    expect(await editor.saveRows([{ values: { name: "甲公司" } }])).toBe(true);
    const creditorId = editor.rows[0]!.id;
    const creditorTable = editor.activeSheet!.tableName;

    const candidates = await searchReferenceCandidates(conn, creditorTable, {
      query: "甲公司",
      displayKey: "name",
    });
    expect(candidates.map((candidate) => candidate.id)).toContain(creditorId);

    await editor.switchSheet(editor.sheets[1]!.id);
    const referenceColumn = editor.columns.find((column) => column.key === "creditor");
    expect(referenceColumn?.referenceTable).toBe(creditorTable);
    expect(referenceColumn?.referenceSheetId).toBe(editor.sheets[0]!.id);
    expect(await editor.saveRows([{ values: { title: "借款合同", creditor: creditorId } }])).toBe(true);
    await editor.reloadRows();
    expect(editor.rows[0]?.values.creditor).toBe(creditorId);
    editor.reset();
  }, 15_000);

  localSurrealTest("同一模板的两个实例拥有隔离的引用目标并拒绝跨实例 RecordId", async () => {
    const { conn } = await setupDatabase();
    const keys = [
      "1111111111111111", "2222222222222222", "3333333333333333",
      "4444444444444444", "5555555555555555", "6666666666666666",
    ];
    const workbooks = createWorkbooksStore({
      getConn: () => conn,
      generateKey: () => keys.shift()!,
    });
    const template = {
      id: "workbook_template:claims",
      sheets: [
        {
          key: "creditors",
          label: "债权人表",
          columns: [{ key: "name", label: "名称", fieldType: "text", required: true }],
        },
        {
          key: "materials",
          label: "证据材料表",
          columns: [{
            key: "creditor",
            label: "关联债权人",
            fieldType: "reference",
            referenceSheetKey: "creditors",
          }],
        },
      ],
    };
    const first = await workbooks.createFromTemplate(template, "实例一");
    const second = await workbooks.createFromTemplate(template, "实例二");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    const firstEditor = createEditorStore({ getConn: () => conn });
    await firstEditor.loadWorkbook(first!.id);
    expect(await firstEditor.saveRows([{ values: { name: "甲公司" } }])).toBe(true);
    const firstCreditorId = firstEditor.rows[0]!.id;
    await firstEditor.switchSheet(firstEditor.sheets[1]!.id);
    const firstTarget = firstEditor.columns.find((column) => column.key === "creditor")?.referenceTable;

    const secondEditor = createEditorStore({ getConn: () => conn });
    await secondEditor.loadWorkbook(second!.id);
    const secondCreditorTable = secondEditor.activeSheet!.tableName;
    await secondEditor.switchSheet(secondEditor.sheets[1]!.id);
    const secondReference = secondEditor.columns.find((column) => column.key === "creditor");

    expect(firstTarget).not.toBe(secondReference?.referenceTable);
    expect(secondReference?.referenceTable).toBe(secondCreditorTable);
    expect(secondReference?.referenceSheetId).toBe(secondEditor.sheets[0]!.id);
    expect(await secondEditor.saveRows([{ values: { creditor: firstCreditorId } }])).toBe(false);
    expect(secondEditor.saveError).toContain(`引用值必须属于 ${secondCreditorTable}`);

    firstEditor.reset();
    secondEditor.reset();
  }, 15_000);
});

describe("OIP-04 模板样例数据可选实例化", () => {
  localSurrealTest("包含样例时编辑器读到样例记录，跨表引用指向同一实例内记录", async () => {
    const { conn } = await setupDatabase();
    const keys = [
      "1111111111111111",
      "2222222222222222",
      "3333333333333333",
      "4444444444444444",
      "5555555555555555",
    ];
    const workbooks = createWorkbooksStore({ getConn: () => conn, generateKey: () => keys.shift()! });
    const workbook = await workbooks.createFromTemplate({
      id: "workbook_template:claims",
      sheets: [
        {
          key: "creditors",
          label: "债权人表",
          columns: [{ key: "name", label: "名称", fieldType: "text", required: true }],
          sampleRecords: [{ key: "creditor-a", values: { name: "甲公司" } }],
        },
        {
          key: "materials",
          label: "证据材料表",
          columns: [
            { key: "title", label: "材料", fieldType: "text", required: true },
            {
              key: "creditor",
              label: "关联债权人",
              fieldType: "reference",
              referenceSheetKey: "creditors",
            },
          ],
          sampleRecords: [{
            key: "material-a",
            values: {
              title: "借款合同",
              creditor: { sheetKey: "creditors", recordKey: "creditor-a" },
            },
          }],
        },
      ],
    });
    expect(workbook).not.toBeNull();

    const editor = createEditorStore({ getConn: () => conn });
    await editor.loadWorkbook(workbook!.id);
    expect(editor.rows.map((row) => row.values.name)).toEqual(["甲公司"]);
    const creditorId = editor.rows[0]!.id;
    await editor.switchSheet(editor.sheets[1]!.id);
    expect(editor.rows).toHaveLength(1);
    expect(editor.rows[0]!.values).toEqual(expect.objectContaining({
      title: "借款合同",
      creditor: creditorId,
    }));
    editor.reset();
  }, 15_000);

  localSurrealTest("创建空台账时保留全部数据表结构且没有业务记录", async () => {
    const { conn } = await setupDatabase();
    const workbooks = createWorkbooksStore({ getConn: () => conn });
    const workbook = await workbooks.createFromTemplate({
      id: "workbook_template:claims",
      sheets: [
        {
          key: "creditors",
          label: "债权人表",
          columns: [{ key: "name", label: "名称", fieldType: "text" }],
          sampleRecords: [{ key: "creditor-a", values: { name: "甲公司" } }],
        },
        {
          key: "materials",
          label: "证据材料表",
          columns: [{ key: "title", label: "材料", fieldType: "text" }],
          sampleRecords: [{ key: "material-a", values: { title: "借款合同" } }],
        },
      ],
    }, undefined, { includeSampleData: false });
    expect(workbook).not.toBeNull();

    const editor = createEditorStore({ getConn: () => conn });
    await editor.loadWorkbook(workbook!.id);
    expect(editor.sheets.map((sheet) => sheet.label)).toEqual(["债权人表", "证据材料表"]);
    expect(editor.rows).toEqual([]);
    await editor.switchSheet(editor.sheets[1]!.id);
    expect(editor.rows).toEqual([]);
    editor.reset();
  }, 15_000);

  localSurrealTest("样例类型错误时结构与业务数据在同一事务中整体回滚", async () => {
    const { conn, inspector } = await setupDatabase();
    const keys = ["1111111111111111", "2222222222222222", "3333333333333333"];
    const workbooks = createWorkbooksStore({ getConn: () => conn, generateKey: () => keys.shift()! });
    const workbook = await workbooks.createFromTemplate({
      id: "workbook_template:claims",
      sheets: [{
        key: "creditors",
        label: "债权人表",
        columns: [{ key: "reviewed", label: "已审核", fieldType: "checkbox" }],
        sampleRecords: [{ key: "creditor-a", values: { reviewed: "错误值" } }],
      }],
    });

    expect(workbook).toBeNull();
    expect(workbooks.error).toContain("模板样例数据不符合字段定义，工作簿未创建");
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
    expect(JSON.stringify(databaseInfo)).not.toContain("ent_1111111111111111_main");
  }, 15_000);

  localSurrealTest("同一模板重复实例化时样例记录拥有不同 RecordId", async () => {
    const { conn } = await setupDatabase();
    const keys = [
      "1111111111111111", "2222222222222222", "3333333333333333",
      "4444444444444444", "5555555555555555", "6666666666666666",
    ];
    const workbooks = createWorkbooksStore({ getConn: () => conn, generateKey: () => keys.shift()! });
    const template = {
      id: "workbook_template:claims",
      sheets: [{
        key: "creditors",
        label: "债权人表",
        columns: [{ key: "name", label: "名称", fieldType: "text" }],
        sampleRecords: [{ key: "creditor-a", values: { name: "甲公司" } }],
      }],
    };
    const first = await workbooks.createFromTemplate(template, "实例一");
    const second = await workbooks.createFromTemplate(template, "实例二");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    const firstEditor = createEditorStore({ getConn: () => conn });
    await firstEditor.loadWorkbook(first!.id);
    const firstRecordId = firstEditor.rows[0]!.id;
    const secondEditor = createEditorStore({ getConn: () => conn });
    await secondEditor.loadWorkbook(second!.id);
    expect(secondEditor.rows[0]!.id).not.toBe(firstRecordId);
    expect(secondEditor.rows[0]!.values.name).toBe("甲公司");
    firstEditor.reset();
    secondEditor.reset();
  }, 15_000);
});
