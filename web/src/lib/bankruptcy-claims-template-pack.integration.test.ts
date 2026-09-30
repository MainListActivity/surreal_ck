import { afterEach, describe, expect, test } from "bun:test";
import { loadTemplatePackScripts } from "@surreal-ck/shared/template-packs";
import { Surreal } from "surrealdb";
import { listDashboardPages, loadDashboardPage } from "./dashboard-data";
import { runDashboardWidgetQuery } from "./dashboard-query";
import { createEditorStore } from "./editor-store";
import { searchReferenceCandidates } from "./reference-cache";
import { createBrowserConn, type SurrealConn } from "./surreal";
import {
  createWorkbookTemplatesStore,
  templateSheetsForCreate,
} from "./workbook-templates";
import { createWorkbooksStore } from "./workbooks";

const localSurrealTest = test.skipIf(process.env.RUN_LOCAL_SURREALDB_TESTS !== "1");
const opened: Surreal[] = [];

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((db) => db.close()));
});

async function setupDatabase(): Promise<SurrealConn> {
  const url = process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
  const namespace = process.env.LOCAL_SURREAL_NS ?? "main";
  const database = `bankruptcy_claims_pack_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const authentication = {
    username: process.env.LOCAL_SURREAL_ROOT_USER ?? "root",
    password: process.env.LOCAL_SURREAL_ROOT_PASS ?? "root",
  };

  const inspector = new Surreal();
  opened.push(inspector);
  await inspector.connect(url, { authentication, namespace, database });
  await inspector.query(`
    DEFINE TABLE workbook_template SCHEMALESS;

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
    DEFINE FIELD template_sheet_key ON TABLE sheet TYPE option<string>;
    DEFINE FIELD created_at ON TABLE sheet TYPE datetime VALUE time::now() READONLY;
    DEFINE FIELD updated_at ON TABLE sheet TYPE datetime VALUE time::now();
    DEFINE INDEX sheet_table_name_unique ON TABLE sheet COLUMNS table_name UNIQUE;

    DEFINE TABLE dashboard_page SCHEMAFULL;
    DEFINE FIELD workbook ON TABLE dashboard_page TYPE option<record<workbook>>;
    DEFINE FIELD title ON TABLE dashboard_page TYPE string;
    DEFINE FIELD slug ON TABLE dashboard_page TYPE string;
    DEFINE FIELD description ON TABLE dashboard_page TYPE option<string>;
    DEFINE FIELD widgets ON TABLE dashboard_page TYPE any DEFAULT [];
    DEFINE FIELD created_at ON TABLE dashboard_page TYPE datetime VALUE time::now() READONLY;
    DEFINE FIELD updated_at ON TABLE dashboard_page TYPE datetime VALUE time::now();
    DEFINE INDEX dashboard_page_slug_unique ON TABLE dashboard_page COLUMNS workbook, slug UNIQUE;

    DEFINE TABLE activity_event SCHEMALESS;
  `).collect();

  const [pack] = await loadTemplatePackScripts({ selectedPacks: ["bankruptcy-claims"] });
  await inspector.query(pack!.sql).collect();

  const browser = new Surreal();
  opened.push(browser);
  const conn = createBrowserConn(browser as never);
  await conn.connect(url, { authentication, namespace, database });
  return conn;
}

describe("CV-02 破产债权管理模板包（两表形状）", () => {
  localSurrealTest("部署选择模板包后可从模板公共列表发现", async () => {
    const conn = await setupDatabase();
    const templates = createWorkbookTemplatesStore({ getConn: () => conn });

    await templates.load();

    expect(templates.byKey("bankruptcy-claims")).toEqual(expect.objectContaining({
      label: "破产债权管理",
      defaultName: "破产债权管理台账",
    }));
  }, 15_000);

  localSurrealTest("从模板创建两张可编辑数据表，样例记录类型合法且引用可选择和回读", async () => {
    const conn = await setupDatabase();
    const templates = createWorkbookTemplatesStore({ getConn: () => conn });
    await templates.load();
    const template = templates.byKey("bankruptcy-claims")!;
    const workbooks = createWorkbooksStore({ getConn: () => conn });

    const workbook = await workbooks.createFromTemplate({
      ...template,
      sheets: templateSheetsForCreate(template),
    });

    expect(workbook).not.toBeNull();
    const editor = createEditorStore({ getConn: () => conn });
    await editor.loadWorkbook(workbook!.id);
    expect(editor.sheets.map((sheet) => sheet.label)).toEqual([
      "债权人",
      "债权申报",
    ]);
    expect(editor.columns.map((column) => [column.key, column.fieldType])).toEqual([
      ["creditor_name", "text"],
      ["identity_type", "text"],
      ["identity_number", "text"],
      ["contact_name", "text"],
      ["contact_phone", "text"],
      ["address", "text"],
    ]);
    expect(editor.rows).toHaveLength(6);
    const creditorIds = new Set(editor.rows.map((row) => row.id));
    const creditorTable = editor.sheets.find((sheet) => sheet.id === editor.activeSheetId)!.tableName;
    const candidates = await searchReferenceCandidates(conn, creditorTable, {
      query: "华辰建设",
      displayKey: "creditor_name",
    });
    expect(candidates.map((candidate) => candidate.primaryLabel)).toContain("华辰建设有限公司");

    await editor.switchSheet(editor.sheets[1]!.id);
    expect(editor.columns.map((column) => [column.key, column.fieldType])).toEqual([
      ["creditor", "reference"],
      ["declared_amount", "decimal"],
      ["interest_amount", "decimal"],
      ["claim_nature", "single_select"],
      ["declared_date", "date"],
      ["evidence_note", "text"],
      ["review_status", "single_select"],
      ["reviewed_amount", "decimal"],
      ["review_opinion", "text"],
    ]);
    expect(editor.columns.find((column) => column.key === "creditor")).toEqual(
      expect.objectContaining({ referenceTable: creditorTable, referenceDisplayKey: "creditor_name" }),
    );
    // 十余笔申报样例，引用全部解析到本次实例的债权人记录。
    expect(editor.rows).toHaveLength(12);
    expect(editor.rows.every((row) => creditorIds.has(String(row.values.creditor)))).toBe(true);
    editor.reset();
  }, 15_000);

  localSurrealTest("模板创建后默认仪表盘组件对演示记录执行真实查询", async () => {
    const conn = await setupDatabase();
    const templates = createWorkbookTemplatesStore({ getConn: () => conn });
    await templates.load();
    const template = templates.byKey("bankruptcy-claims")!;
    const workbooks = createWorkbooksStore({ getConn: () => conn });
    const workbook = await workbooks.createFromTemplate({
      ...template,
      sheets: templateSheetsForCreate(template),
    });
    expect(workbook).not.toBeNull();

    const pages = await listDashboardPages(conn, { workbookId: workbook!.id });
    expect(pages).toHaveLength(1);
    const page = await loadDashboardPage(conn, pages[0]!.id);
    expect(page?.widgets.map((widget) => widget.title)).toEqual([
      "总申报金额",
      "总审定金额",
      "待审查申报",
      "债权性质分布",
      "审查状态分布",
      "最近申报",
    ]);

    const results = await Promise.all(page!.widgets.map((widget) => runDashboardWidgetQuery(conn, widget)));
    expect(Number((results[0]!.result as { value: unknown }).value)).toBe(7_481_000);
    expect(Number((results[1]!.result as { value: unknown }).value)).toBe(2_585_000);
    expect((results[2]!.result as { value: unknown }).value).toBe(5);
    expect((results[3]!.result as { rows: unknown[] }).rows).toHaveLength(4);
    expect((results[4]!.result as { rows: unknown[] }).rows).toHaveLength(5);
    expect((results[5]!.result as { rows: unknown[] }).rows).toHaveLength(8);
  }, 15_000);
});
