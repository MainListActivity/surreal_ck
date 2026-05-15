/**
 * 数据表运行时的真实 SurrealDB 集成测试。
 *
 * 用 `surreal start memory` 启一个本地实例，通过 WS 连接驱动；绕开
 * surrealdb-node embedded 在 `bun test` 下的 NAPI worker 挂起问题
 * （见 src/main/db/index.test.ts 顶部注释）。
 *
 * 这些测试以 root 身份执行，不走 PERMISSIONS。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Surreal } from "surrealdb";

const port = 41000 + Math.floor(Math.random() * 1000);
const db = new Surreal();
let surrealProc: ReturnType<typeof Bun.spawn> | null = null;

async function waitForReady(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const probe = new Surreal();
      await probe.connect(`ws://127.0.0.1:${port}/rpc`);
      await probe.close();
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error(`[surreal] failed to boot on port ${port}`);
}

beforeAll(async () => {
  surrealProc = Bun.spawn({
    cmd: [
      "surreal", "start",
      "--bind", `127.0.0.1:${port}`,
      "--user", "root",
      "--pass", "root",
      "memory",
    ],
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForReady();
  await db.connect(`ws://127.0.0.1:${port}/rpc`);
  await db.signin({ username: "root", password: "root" });
  await db.use({ namespace: "test", database: "test" });

  // 只定义运行时需要的 sheet/workbook/workspace 最小结构，不加载完整 schema —
  // 完整 schema 会绑死 $auth/PERMISSIONS，集成测试不需要那些。
  await db.query(`
    DEFINE TABLE IF NOT EXISTS workspace SCHEMALESS;
    DEFINE TABLE IF NOT EXISTS workbook SCHEMALESS;
    DEFINE TABLE IF NOT EXISTS sheet SCHEMALESS;
  `);
});

beforeEach(async () => {
  const { setOfflineMode } = await import("./offline-state");
  setOfflineMode(false);
  await db.query(`
    DELETE sheet; DELETE workbook; DELETE workspace;
  `);
});

afterAll(async () => {
  await db.close();
  surrealProc?.kill();
});

mock.module("../db/index", () => ({
  getLocalDb: () => db,
}));

mock.module("../auth/session", () => ({
  getSession: () => ({ expiresAt: Date.now() + 3600_000 }),
  getPublicAuthState: () => ({ loggedIn: true, expiresAt: Date.now() + 3600_000 }),
}));

mock.module("../sync/exec-template", () => ({
  EXEC_TEMPLATE_IDS: {
    entityTable: "ddl-entity-table",
    relationTable: "ddl-relation-table",
    entityFieldAdd: "ddl-entity-field-add",
    entityFieldOverwrite: "ddl-entity-field-overwrite",
    entityFieldRemove: "ddl-entity-field-remove",
  },
  execTemplate: async () => undefined,
}));

// 这些 import 必须在 mock.module 之后，否则会先解析真实的 db/index。
const { DataTableRuntime } = await import("./data-table-runtime");

describe("DataTableRuntime.loadByTableName", () => {
  test("返回包装好的运行时实例，columns 来自 sheet.column_defs", async () => {
    await db.query(`
      CREATE workspace:ws1 SET name = 'WS';
      CREATE workbook:wb1 SET workspace = workspace:ws1, name = 'WB';
      CREATE sheet:s1 SET
        workbook = workbook:wb1,
        univer_id = 'u1',
        table_name = 'ent_demo_table',
        label = 'Demo',
        position = 0,
        column_defs = [
          { key: 'title', label: '标题', field_type: 'text' }
        ];
    `);

    const runtime = await DataTableRuntime.loadByTableName("ent_demo_table");

    expect(runtime).not.toBeNull();
    expect(runtime!.tableName).toBe("ent_demo_table");
    expect(runtime!.columns).toEqual([
      expect.objectContaining({ key: "title", label: "标题", fieldType: "text" }),
    ]);
  });

  test("找不到对应 sheet 时返回 null", async () => {
    const runtime = await DataTableRuntime.loadByTableName("ent_missing");
    expect(runtime).toBeNull();
  });

  test("非法实体表名直接拒绝（不发查询）", async () => {
    await expect(DataTableRuntime.loadByTableName("workbook"))
      .rejects.toThrow();
  });
});

describe("DataTableRuntime#applyColumnUpdate", () => {
  async function seedSheet(tableName: string, columnDefs: Array<Record<string, unknown>>) {
    await db.query(`
      CREATE workspace:ws1 SET name = 'WS';
      CREATE workbook:wb1 SET workspace = workspace:ws1, name = 'WB';
      CREATE sheet:s1 SET
        workbook = workbook:wb1,
        univer_id = 'u1', table_name = $tn,
        label = 'S', position = 0,
        column_defs = $defs;
      DEFINE TABLE IF NOT EXISTS ${tableName} SCHEMALESS;
    `, { tn: tableName, defs: columnDefs });
  }

  test("normalize + 去重 + 写回 sheet.column_defs", async () => {
    await seedSheet("ent_demo_a", [
      { key: "title", label: "标题", field_type: "text" },
    ]);
    const runtime = await DataTableRuntime.loadByTableName("ent_demo_a");
    expect(runtime).not.toBeNull();

    const next = await runtime!.applyColumnUpdate([
      { key: " title ", label: "标题", fieldType: "text" },
      { key: "status", label: "状态", fieldType: "single_select", options: ["Open", "Closed"] },
    ]);

    expect(next.columns.map((c) => c.key)).toEqual(["title", "status"]);
    const rows = await db.query<[Array<{ column_defs: Array<{ key: string }> }>]>(
      `SELECT column_defs FROM sheet:s1`,
    );
    expect(rows[0]?.[0]?.column_defs.map((c) => c.key)).toEqual(["title", "status"]);
  });

  test("DDL：新增字段 overwrite 写入物理表", async () => {
    await seedSheet("ent_demo_b", []);
    const runtime = await DataTableRuntime.loadByTableName("ent_demo_b");
    await runtime!.applyColumnUpdate([
      { key: "title", label: "标题", fieldType: "text" },
    ]);
    const info = await db.query<[{ fields?: Record<string, string> }]>(
      `INFO FOR TABLE ent_demo_b`,
    );
    expect(Object.keys(info[0]?.fields ?? {})).toContain("title");
  });

  test("被删除的字段从物理表上 REMOVE", async () => {
    await seedSheet("ent_demo_c", [
      { key: "old_field", label: "Old", field_type: "text" },
      { key: "kept", label: "Kept", field_type: "text" },
    ]);
    // 物理表上先建好字段，模拟 schema 与 sheet.column_defs 已经一致的状态
    await db.query(`
      DEFINE FIELD old_field ON TABLE ent_demo_c TYPE option<string>;
      DEFINE FIELD kept      ON TABLE ent_demo_c TYPE option<string>;
    `);

    const runtime = await DataTableRuntime.loadByTableName("ent_demo_c");
    await runtime!.applyColumnUpdate([
      { key: "kept", label: "Kept", fieldType: "text" },
    ]);

    const info = await db.query<[{ fields?: Record<string, string> }]>(
      `INFO FOR TABLE ent_demo_c`,
    );
    expect(Object.keys(info[0]?.fields ?? {})).not.toContain("old_field");
    expect(Object.keys(info[0]?.fields ?? {})).toContain("kept");
  });

  test("空列数组拒绝", async () => {
    await seedSheet("ent_demo_d", [
      { key: "title", label: "标题", field_type: "text" },
    ]);
    const runtime = await DataTableRuntime.loadByTableName("ent_demo_d");
    await expect(runtime!.applyColumnUpdate([])).rejects.toThrow("至少保留一个字段");
  });

  test("normalize 后 key 重复拒绝", async () => {
    await seedSheet("ent_demo_e", []);
    const runtime = await DataTableRuntime.loadByTableName("ent_demo_e");
    await expect(runtime!.applyColumnUpdate([
      { key: "title", label: "A", fieldType: "text" },
      { key: " title ", label: "B", fieldType: "text" },
    ])).rejects.toThrow("字段标识重复");
  });
});

describe("DataTableRuntime#buildEntityPreview", () => {
  test("primaryLabel 走 'name' 字段且 prefix 带 workbook/sheet", async () => {
    await db.query(`
      CREATE workspace:ws1 SET name = '运营';
      CREATE workbook:wb1 SET workspace = workspace:ws1, name = '合同台账';
      CREATE sheet:s1 SET
        workbook = workbook:wb1,
        univer_id = 'u', table_name = 'ent_preview_a',
        label = '合同', position = 0,
        column_defs = [
          { key: 'name', label: '名称', field_type: 'text' },
          { key: 'note', label: '备注', field_type: 'text' }
        ];
    `);

    const runtime = await DataTableRuntime.loadByTableName("ent_preview_a");
    const preview = runtime!.buildEntityPreview("ent_preview_a:row1", {
      id: "ent_preview_a:row1",
      name: "案件 A",
      note: "demo",
    });

    expect(preview.id).toBe("ent_preview_a:row1");
    expect(preview.table).toBe("ent_preview_a");
    expect(preview.workspaceName).toBe("运营");
    expect(preview.workbookName).toBe("合同台账");
    expect(preview.sheetName).toBe("合同");
    expect(preview.primaryLabel).toBe("合同台账 / 合同 / 案件 A");
    expect(preview.preview.map((p) => p.key)).toEqual(["name", "note"]);
  });

  test("空值字段不出现在 preview 列表里", async () => {
    await db.query(`
      CREATE workspace:ws1 SET name = 'WS';
      CREATE workbook:wb1 SET workspace = workspace:ws1, name = 'WB';
      CREATE sheet:s1 SET
        workbook = workbook:wb1,
        univer_id = 'u', table_name = 'ent_preview_b',
        label = 'S', position = 0,
        column_defs = [
          { key: 'name', label: '名称', field_type: 'text' },
          { key: 'empty1', label: '空1', field_type: 'text' },
          { key: 'empty2', label: '空2', field_type: 'text' }
        ];
    `);
    const runtime = await DataTableRuntime.loadByTableName("ent_preview_b");
    const preview = runtime!.buildEntityPreview("ent_preview_b:x", {
      id: "ent_preview_b:x",
      name: "X",
      empty1: null,
      empty2: "",
    });
    expect(preview.preview.map((p) => p.key)).toEqual(["name"]);
  });

  test("forceDisplayKey 覆盖默认 name 选择", async () => {
    await db.query(`
      CREATE workspace:ws1 SET name = 'WS';
      CREATE workbook:wb1 SET workspace = workspace:ws1, name = 'WB';
      CREATE sheet:s1 SET
        workbook = workbook:wb1,
        univer_id = 'u', table_name = 'ent_preview_c',
        label = 'S', position = 0,
        column_defs = [
          { key: 'name', label: '名称', field_type: 'text' },
          { key: 'matter_id', label: '编号', field_type: 'text' }
        ];
    `);
    const runtime = await DataTableRuntime.loadByTableName("ent_preview_c");
    const preview = runtime!.buildEntityPreview("ent_preview_c:r1", {
      id: "ent_preview_c:r1",
      name: "案件 A",
      matter_id: "2026-001",
    }, { forceDisplayKey: "matter_id" });
    expect(preview.primaryLabel).toBe("WB / S / 2026-001");
  });
});

describe("DataTableRuntime.listAllForReference", () => {
  test("列出所有 ent_* sheet 的运行时实例，附带 workspace/workbook 元数据", async () => {
    await db.query(`
      CREATE workspace:ws1 SET name = '业务工作区';
      CREATE workbook:wb1 SET workspace = workspace:ws1, name = '合同台账';
      CREATE sheet:s1 SET
        workbook = workbook:wb1,
        univer_id = 'u1', table_name = 'ent_a',
        label = 'Sheet A', position = 0,
        column_defs = [{ key: 'name', label: '名称', field_type: 'text' }];
      CREATE sheet:s2 SET
        workbook = workbook:wb1,
        univer_id = 'u2', table_name = 'ent_b',
        label = 'Sheet B', position = 1,
        column_defs = [];
    `);

    const items = await DataTableRuntime.listAllForReference();

    expect(items.map((i) => i.runtime.tableName).sort()).toEqual(["ent_a", "ent_b"]);
    const first = items.find((i) => i.runtime.tableName === "ent_a")!;
    expect(first.workbookName).toBe("合同台账");
    expect(first.workspaceName).toBe("业务工作区");
    expect(first.sheetLabel).toBe("Sheet A");
  });

  test("非 ent_* 表名被排除（保护同步投影侧不重新扫描 system 表）", async () => {
    await db.query(`
      CREATE workspace:ws1 SET name = 'WS';
      CREATE workbook:wb1 SET workspace = workspace:ws1, name = 'WB';
      CREATE sheet:s1 SET
        workbook = workbook:wb1,
        univer_id = 'u', table_name = 'app_user',
        label = 'Bad', position = 0, column_defs = [];
    `);
    const items = await DataTableRuntime.listAllForReference();
    expect(items).toHaveLength(0);
  });
});
