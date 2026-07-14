import { describe, expect, test } from "bun:test";
import type { SurrealConn } from "./surreal";
import {
  buildCreateWorkbookTransaction,
  createWorkbooksStore,
  entityTableNameForWorkbook,
  filterWorkbooksByQuery,
  type WorkbookRow,
} from "./workbooks";

type Recorder = {
  queries: Array<{ sql: string; bindings: unknown }>;
  creates: Array<{ table: string; data: Record<string, unknown> }>;
  updates: Array<{ id: string; patch: Record<string, unknown> }>;
};

/** fake conn：SELECT FROM workbook 返回注入的列表；createRecord 给新 workbook 一个真实 id。 */
function setup(opts: {
  workbooks?: Array<Record<string, unknown>>;
  createThrows?: unknown;
  updateThrows?: unknown;
} = {}) {
  const rec: Recorder = { queries: [], creates: [], updates: [] };
  const rows = opts.workbooks ?? [];
  let createSeq = 0;

  const conn = {
    status: "connected",
    connect: async () => true,
    use: async () => ({}),
    close: async () => true,
    subscribe: () => () => {},
    query: (async (sql: string, bindings?: Record<string, unknown>) => {
      rec.queries.push({ sql, bindings });
      // createBlank 走多语句事务（BEGIN TRANSACTION）；用 createThrows 模拟引擎拒绝。
      if (/BEGIN TRANSACTION/i.test(sql) && opts.createThrows) throw opts.createThrows;
      return rows;
    }) as SurrealConn["query"],
    liveTable: (async () => () => {}) as SurrealConn["liveTable"],
    updateRecord: (async (id: string, patch: Record<string, unknown>) => {
      if (opts.updateThrows) throw opts.updateThrows;
      rec.updates.push({ id, patch });
      return { id, ...patch };
    }) as SurrealConn["updateRecord"],
    createRecord: (async (table: string, data: Record<string, unknown>) => {
      if (opts.createThrows) throw opts.createThrows;
      rec.creates.push({ table, data });
      createSeq += 1;
      return { id: `${table}:new${createSeq}`, ...data };
    }) as SurrealConn["createRecord"],
    deleteRecord: (async () => ({})) as SurrealConn["deleteRecord"],
    transaction: (async (run: (tx: SurrealConn) => Promise<unknown>) => run(conn)) as SurrealConn["transaction"],
  } as SurrealConn;

  const store = createWorkbooksStore({ getConn: () => conn });
  return { store, conn, rec };
}

const sampleRows = [
  { id: "workbook:wb1", name: "案件台账", template: "workbook_template:case", updated_at: "2026-05-20" },
  { id: "workbook:wb2", name: "财务汇总", updated_at: "2026-05-19" },
];

describe("load — 直连读 workbook 列表", () => {
  test("SELECT FROM workbook 按 updated_at 倒序，记录裁成 WorkbookRow", async () => {
    const { store, rec } = setup({ workbooks: sampleRows });

    await store.load();

    expect(rec.queries[0].sql).toMatch(/FROM workbook/i);
    expect(rec.queries[0].sql).toMatch(/ORDER BY updated_at DESC/i);
    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
    expect(store.workbooks).toEqual([
      { id: "workbook:wb1", name: "案件台账", templateRef: "workbook_template:case", updatedAt: "2026-05-20" },
      { id: "workbook:wb2", name: "财务汇总", templateRef: undefined, updatedAt: "2026-05-19" },
    ]);
  });

  test("查询抛错 → error 落到 state，workbooks 不变", async () => {
    const { store } = setup({ workbooks: sampleRows });
    await store.load();
    // 把 conn.query 换成抛错的，再 load 一次
    const broken = createWorkbooksStore({
      getConn: () =>
        ({
          query: async () => {
            throw new Error("boom");
          },
        }) as unknown as SurrealConn,
    });
    await broken.load();
    expect(broken.error).not.toBeNull();
    expect(broken.workbooks).toEqual([]);
  });
});

describe("createBlank — 管理员建空白 workbook", () => {
  test("走单条事务（建实体表+workbook+sheet）并把新 workbook 插到列表头", async () => {
    const { store, rec } = setup({ workbooks: [...sampleRows] });
    await store.load();

    const created = await store.createBlank("新工作簿");

    // 不再走 createRecord，而是一条 BEGIN/COMMIT 事务
    expect(rec.creates).toEqual([]);
    const txQuery = rec.queries.find((q) => /BEGIN TRANSACTION/i.test(q.sql));
    expect(txQuery).toBeDefined();
    const sql = txQuery!.sql;
    // DDL：建实体表 + 默认 name 列，都在同一事务里
    expect(sql).toMatch(/DEFINE TABLE IF NOT EXISTS ent_[0-9a-f]+_main SCHEMALESS/);
    expect(sql).toMatch(/DEFINE FIELD IF NOT EXISTS name ON TABLE ent_[0-9a-f]+_main TYPE string/);
    // workbook + sheet 两条 CREATE
    expect(sql).toMatch(/CREATE workbook:[0-9a-f]+ CONTENT/);
    expect(sql).toMatch(/CREATE sheet:[0-9a-f]+ CONTENT/);
    expect(sql).toMatch(/COMMIT TRANSACTION/);
    // sheet 指向新建的实体表，列定义带默认 name 列
    const b = txQuery!.bindings as Record<string, unknown>;
    expect(String(b.tableName)).toMatch(/^ent_[0-9a-f]+_main$/);
    expect(b.columnDefs).toEqual([
      { key: "name", label: "名称", field_type: "text", required: true },
    ]);

    expect(created?.id).toMatch(/^workbook:[0-9a-f]+$/);
    // 空白工作簿无类型：templateRef 为 undefined，CREATE 不带 template 字段
    expect(store.workbooks[0]).toEqual({ id: created!.id, name: "新工作簿", templateRef: undefined });
    expect(sql).not.toContain("template:");
  });

  test("无权限（participant 尝试建表）→ 返回 null 且 error 是中文提示", async () => {
    const { store } = setup({ createThrows: new Error("IAM error: Not allowed to create") });
    await store.load();

    const created = await store.createBlank("新工作簿");

    expect(created).toBeNull();
    expect(store.error).toContain("没有权限");
  });
});

describe("createFromTemplate — 从业务模板建工作簿（带类型）", () => {
  test("双数据表模板在同一事务中创建两张独立实体表和数据表元数据", async () => {
    const { store, rec } = setup();

    const created = await store.createFromTemplate({
      id: "workbook_template:claims",
      defaultName: "破产债权台账",
      sheets: [
        {
          label: "债权人表",
          columns: [
            { key: "creditor_name", label: "债权人名称", fieldType: "text", required: true },
          ],
        },
        {
          label: "证据材料表",
          columns: [
            { key: "material_name", label: "材料名称", fieldType: "text", required: true },
          ],
        },
      ],
    });

    const transactions = rec.queries.filter((query) => /BEGIN TRANSACTION/i.test(query.sql));
    expect(transactions).toHaveLength(1);
    const transaction = transactions[0]!;
    const entityTables = [...transaction.sql.matchAll(/DEFINE TABLE IF NOT EXISTS (ent_[0-9a-f_]+) SCHEMALESS/g)]
      .map((match) => match[1]);
    expect(entityTables).toHaveLength(2);
    expect(new Set(entityTables).size).toBe(2);
    expect(transaction.sql.match(/CREATE sheet:[0-9a-f]+ CONTENT/g)).toHaveLength(2);
    expect(transaction.bindings).toEqual(expect.objectContaining({
      name: "破产债权台账",
      sheetLabel0: "债权人表",
      sheetColumnDefs0: [expect.objectContaining({ key: "creditor_name" })],
      sheetLabel1: "证据材料表",
      sheetColumnDefs1: [expect.objectContaining({ key: "material_name" })],
    }));
    expect(created?.templateRef).toBe("workbook_template:claims");
  });

  test("新模板包的首个数据表展示名和字段进入创建事务", async () => {
    const { store, rec } = setup();

    const created = await store.createFromTemplate({
      id: "workbook_template:claims",
      defaultName: "破产债权台账",
      sheet: {
        label: "债权人表",
        columns: [
          { key: "creditor_name", label: "债权人名称", fieldType: "text", required: true },
          { key: "claim_amount", label: "申报金额", fieldType: "decimal" },
        ],
      },
    });

    const txQuery = rec.queries.find((query) => /BEGIN TRANSACTION/i.test(query.sql));
    expect(txQuery?.bindings).toEqual(expect.objectContaining({
      name: "破产债权台账",
      label: "债权人表",
      columnDefs: [
        expect.objectContaining({ key: "creditor_name", field_type: "text", required: true }),
        expect.objectContaining({ key: "claim_amount", field_type: "decimal" }),
      ],
    }));
    expect(created?.templateRef).toBe("workbook_template:claims");
  });

  test("workbook CREATE 带 template 引用，实体表按模板列定义建列，默认名回退模板 defaultName", async () => {
    const { store, rec } = setup({ workbooks: [...sampleRows] });
    await store.load();

    const created = await store.createFromTemplate({
      id: "workbook_template:case",
      defaultName: "未命名案件库",
      columns: [
        { key: "name", label: "案件名", fieldType: "text", required: true },
        { key: "amount", label: "金额", fieldType: "decimal" },
      ],
    });

    const txQuery = rec.queries.find((q) => /BEGIN TRANSACTION/i.test(q.sql));
    const sql = txQuery!.sql;
    // 工作簿带上 template 引用 = 类型
    expect(sql).toMatch(/CREATE workbook:[0-9a-f]+ CONTENT \{[^}]*template: workbook_template:case/);
    // 实体表按模板两列建 DEFINE FIELD
    expect(sql).toMatch(/DEFINE FIELD IF NOT EXISTS name ON TABLE ent_[0-9a-f]+_main TYPE string/);
    expect(sql).toMatch(/DEFINE FIELD IF NOT EXISTS amount ON TABLE ent_[0-9a-f]+_main TYPE option<number>/);
    // 列定义存进 sheet.column_defs（stored 形态）
    const b = txQuery!.bindings as Record<string, unknown>;
    expect(b.columnDefs).toEqual([
      { key: "name", label: "案件名", field_type: "text", required: true, options: undefined, constraints: undefined, date_format: undefined, reference_table: undefined, reference_sheet_id: undefined, reference_multiple: undefined, reference_display_key: undefined },
      { key: "amount", label: "金额", field_type: "decimal", required: undefined, options: undefined, constraints: undefined, date_format: undefined, reference_table: undefined, reference_sheet_id: undefined, reference_multiple: undefined, reference_display_key: undefined },
    ]);
    expect(b.name).toBe("未命名案件库");
    expect(created?.templateRef).toBe("workbook_template:case");
  });
});

describe("buildCreateWorkbookTransaction — 纯 SurrealQL 构造", () => {
  test("实例化使用注入的随机 key 边界预生成 workbook 与全部 sheet 标识", async () => {
    const keys = ["1111111111111111", "2222222222222222", "3333333333333333"];
    const queries: string[] = [];
    const conn = {
      query: async (sql: string) => {
        queries.push(sql);
        return [];
      },
    } as unknown as SurrealConn;
    const store = createWorkbooksStore({
      getConn: () => conn,
      generateKey: () => keys.shift()!,
    });

    const workbook = await store.createFromTemplate({
      id: "workbook_template:claims",
      sheets: [
        { label: "A", columns: [{ key: "name", label: "名称", fieldType: "text" }] },
        { label: "B", columns: [{ key: "title", label: "标题", fieldType: "text" }] },
      ],
    });

    expect(workbook?.id).toBe("workbook:1111111111111111");
    expect(queries[0]).toContain("CREATE sheet:2222222222222222 CONTENT");
    expect(queries[0]).toContain("CREATE sheet:3333333333333333 CONTENT");
  });

  test("表名 / workbook id / sheet 三者 key 一致且引用闭环", () => {
    const { sql, bindings, workbookId } = buildCreateWorkbookTransaction("台账");
    const wbKey = workbookId.replace("workbook:", "");
    expect(bindings.tableName).toBe(entityTableNameForWorkbook(wbKey));
    expect(bindings.name).toBe("台账");
    expect(bindings.label).toBe("Sheet 1");
    // sheet CONTENT 里 workbook 指回同一个 workbook id
    expect(sql).toContain(`workbook: ${workbookId}`);
    // workbook last_opened_sheet 指向 sheet id
    expect(sql).toMatch(/last_opened_sheet: sheet:[0-9a-f]+/);
  });

  test("实体表挂 record_activity event：行 CREATE/DELETE 自动落 activity_event", () => {
    const { sql, bindings } = buildCreateWorkbookTransaction("台账");
    const tableName = String(bindings.tableName);
    // event 定义与建表在同一事务内
    expect(sql).toMatch(new RegExp(`DEFINE EVENT (IF NOT EXISTS |OVERWRITE )?\\w+ ON TABLE ${tableName}`));
    // CREATE → record.write，DELETE → record.delete
    expect(sql).toContain('"record.write"');
    expect(sql).toContain('"record.delete"');
    // 写入 activity_event，归因由表字段 DEFAULT fn::current_user() 负责（event 内不手填 actor）
    expect(sql).toContain("CREATE activity_event CONTENT");
    expect(sql).not.toContain("actor:");
    // 事件 THEN 块只在 CREATE/DELETE 触发（数据行 UPDATE 不算"新增/删除记录"，避免刷屏）
    expect(sql).toMatch(/WHEN \$event = "CREATE" OR \$event = "DELETE"/);
  });

  test("用户输入只进 bindings，不拼进 SQL 文本（防注入）", () => {
    const { sql, bindings } = buildCreateWorkbookTransaction("'; DROP TABLE workbook; --");
    expect(sql).not.toContain("DROP TABLE workbook");
    expect(bindings.name).toBe("'; DROP TABLE workbook; --");
    expect(sql).toContain("name: $name");
  });
});

describe("rename — 改 workbook 名", () => {
  test("走 updateRecord 并就地更新列表项", async () => {
    const { store, rec } = setup({ workbooks: [...sampleRows] });
    await store.load();

    const ok = await store.rename("workbook:wb2", "财务总表");

    expect(ok).toBe(true);
    expect(rec.updates).toEqual([{ id: "workbook:wb2", patch: { name: "财务总表" } }]);
    expect(store.workbooks.find((w) => w.id === "workbook:wb2")?.name).toBe("财务总表");
  });

  test("无权限 → 返回 false 且 error 是中文提示", async () => {
    const { store } = setup({
      workbooks: [...sampleRows],
      updateThrows: new Error("permission denied"),
    });
    await store.load();

    const ok = await store.rename("workbook:wb2", "财务总表");

    expect(ok).toBe(false);
    expect(store.error).toContain("没有权限");
  });
});

describe("filterWorkbooksByQuery — 纯过滤", () => {
  const list: WorkbookRow[] = [
    { id: "workbook:wb1", name: "案件台账", templateRef: "workbook_template:case" },
    { id: "workbook:wb2", name: "财务汇总" },
  ];

  test("空 query 返回全部", () => {
    expect(filterWorkbooksByQuery(list, "")).toEqual(list);
  });

  test("按 name 大小写不敏感匹配", () => {
    expect(filterWorkbooksByQuery(list, "案件").map((w) => w.id)).toEqual(["workbook:wb1"]);
    expect(filterWorkbooksByQuery(list, "汇总").map((w) => w.id)).toEqual(["workbook:wb2"]);
    expect(filterWorkbooksByQuery(list, "xyz")).toEqual([]);
  });
});
