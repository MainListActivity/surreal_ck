import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { StringRecordId, Surreal, Table } from "surrealdb";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { createBrowserConn, type SurrealConn } from "./surreal";
import { recordToTemplate, templateColumnDefs, templateSheetsForCreate } from "./workbook-templates";
import { createWorkbooksStore, type TemplateForCreate } from "./workbooks";

// 默认运行。独立内存实例 + 真实 workspace schema + 原样 admin/participant JWT access。
// 这里只证明事务/身份契约；不冒充生产 fork 的原生配额验收。
const namespace = "template_test";
const sessions: Surreal[] = [];
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "template-test", alg: "RS256", use: "sig" };
let processHandle: ReturnType<typeof Bun.spawn>;
let jwksServer: ReturnType<typeof Bun.serve>;
let endpoint: string;
const password = crypto.randomUUID();
let sequence = 0;

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("port unavailable"));
      server.close(() => resolve(address.port));
    });
  });
}

function token(database: string, access: "admin" | "participant"): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = `${encode({ alg: "RS256", kid: "template-test" })}.${encode({
    ns: namespace, db: database, ac: access, RL: ["Owner"], sub: access,
    email: `${access}@example.test`, exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
  return `${payload}.${sign("RSA-SHA256", Buffer.from(payload), keys.privateKey).toString("base64url")}`;
}

async function open(): Promise<Surreal> {
  const db = new Surreal();
  sessions.push(db);
  await db.connect(endpoint);
  return db;
}

beforeAll(async () => {
  jwksServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ keys: [publicJwk] }) });
  const port = await freePort();
  endpoint = `ws://127.0.0.1:${port}/rpc`;
  processHandle = Bun.spawn([
    process.env.SURREAL_BINARY ?? `${homedir()}/.surrealdb/surreal`,
    "start", "--allow-all", "--bind", `127.0.0.1:${port}`, "--user", "test", "--pass", password, "memory",
  ], { stdout: "ignore", stderr: "ignore" });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch { /* 等待测试实例启动 */ }
    await Bun.sleep(50);
  }
  throw new Error("isolated SurrealDB failed to start");
}, 15_000);

afterAll(async () => {
  await Promise.allSettled(sessions.map((db) => db.close()));
  jwksServer?.stop(true);
  processHandle?.kill();
  if (processHandle) await processHandle.exited;
});

const packageRow = {
  id: "equipment", key: "equipment", label: "设备运维", default_name: "设备台账",
  sheet_defs: [
    { key: "assets", label: "设备", column_defs: [{ key: "name", label: "名称", field_type: "text", required: true }],
      sample_records: [{ key: "a", values: { name: "设备 A" } }] },
    { key: "checks", label: "巡检", column_defs: [
      { key: "asset", label: "设备", field_type: "reference", reference_sheet_key: "assets" },
      { key: "score", label: "评分", field_type: "number" },
    ], sample_records: [{ key: "c", values: { asset: { sheet_key: "assets", record_key: "a" }, score: 3 } }] },
  ],
};

async function setup(): Promise<{ root: Surreal; conn: SurrealConn; member: SurrealConn; template: TemplateForCreate }> {
  const database = `instance_${sequence++}`;
  const root = await open();
  await root.signin({ username: "test", password });
  await root.use({ namespace, database });
  for (const script of await loadTemplateScripts({ oidcJwksUrl: `http://127.0.0.1:${jwksServer.port}/jwks` })) {
    await root.query(script.sql).collect();
  }
  // 旧配额事件仍随 workspace 模板落库；仅在测试库提高占位值，使事务测试不被套餐上限遮蔽。
  await root.query("UPDATE resource_quota_plan SET max_sheets = 100, max_fields_per_sheet = 100, max_records_per_sheet = 100").collect();
  await root.insert(new Table("user"), [
    { subject: "admin", email: "admin@example.test", kind: "human", is_admin: true },
    { subject: "participant", email: "participant@example.test", kind: "human", is_admin: false },
  ]);
  const [row] = await root.insert<Record<string, unknown>>(new Table("workbook_template"), packageRow);
  const converted = recordToTemplate(row!);
  const template: TemplateForCreate = {
    id: converted.id, defaultName: converted.defaultName, sheets: templateSheetsForCreate(converted),
  };
  const adminDb = await open();
  await adminDb.use({ namespace, database });
  await adminDb.authenticate(token(database, "admin"));
  const memberDb = await open();
  await memberDb.use({ namespace, database });
  // RL=Owner 也不能让 RECORD access 获得管理员 DDL 权限。
  await memberDb.authenticate(token(database, "participant"));
  return { root, conn: createBrowserConn(adminDb as never), member: createBrowserConn(memberDb as never), template };
}

async function snapshot(root: Surreal): Promise<unknown> {
  return await root.query("SELECT * FROM workbook; SELECT * FROM sheet; RETURN (INFO FOR DB).tables; SELECT * FROM sheet_resource_usage; SELECT * FROM activity_event;").collect();
}

describe("模板创建：真实管理员事务与成员边界", () => {
  test("两次带样例实例化保持模板关联且表、记录和跨表引用全部隔离", async () => {
    const { root, conn, template } = await setup();
    const store = createWorkbooksStore({ getConn: () => conn });
    const first = await store.createFromTemplate(template);
    const second = await store.createFromTemplate(template);
    expect(store.error).toBeNull();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    const workbooks = await root.select<Record<string, unknown>>(new Table("workbook"));
    expect(workbooks.map((row) => String(row.template))).toEqual([template.id, template.id]);
    const instances: Array<{ table: string; record: string }> = [];
    for (const workbook of [first!, second!]) {
      const sheets = await conn.query<{ table_name: string; template_sheet_key: string; column_defs: Array<Record<string, unknown>> }>(
        "SELECT * FROM sheet WHERE workbook = $workbook", { workbook: new StringRecordId(workbook.id) },
      );
      expect(sheets).toHaveLength(2);
      const assets = sheets.find((sheet) => sheet.template_sheet_key === "assets")!;
      const checks = sheets.find((sheet) => sheet.template_sheet_key === "checks")!;
      expect(checks.column_defs[0]?.reference_table).toBe(assets.table_name);
      const assetRows = await conn.query<Record<string, unknown>>(`SELECT * FROM ${assets.table_name}`);
      const checkRows = await conn.query<Record<string, unknown>>(`SELECT * FROM ${checks.table_name}`);
      expect(assetRows).toHaveLength(1);
      expect(checkRows).toHaveLength(1);
      expect(String(checkRows[0]!.asset)).toBe(String(assetRows[0]!.id));
      instances.push({ table: assets.table_name, record: String(assetRows[0]!.id) });
    }
    expect(instances[0]!.table).not.toBe(instances[1]!.table);
    expect(instances[0]!.record).not.toBe(instances[1]!.record);
  }, 30_000);

  test("关闭样例后只建完整结构；无模板空白创建和旧单表模板继续可用", async () => {
    const { root, conn, template } = await setup();
    const store = createWorkbooksStore({ getConn: () => conn });
    expect(await store.createFromTemplate(template, undefined, { includeSampleData: false })).not.toBeNull();
    const sheets = await root.select<{ table_name: string }>(new Table("sheet"));
    expect(sheets).toHaveLength(2);
    for (const sheet of sheets) expect(await conn.query(`SELECT * FROM ${sheet.table_name}`)).toEqual([]);
    await root.delete(new Table("workbook_template"));
    expect(await store.createBlank("空白台账")).not.toBeNull();
    const [legacyRow] = await root.insert<Record<string, unknown>>(new Table("workbook_template"), {
      key: "legacy", label: "旧单表", column_defs: [{ key: "title", label: "标题", field_type: "text" }],
    });
    const legacy = recordToTemplate(legacyRow!);
    const workbook = await store.createFromTemplate({ id: legacy.id, columns: templateColumnDefs(legacy) });
    expect(workbook).not.toBeNull();
    const legacySheets = await conn.query<{ table_name: string }>("SELECT * FROM sheet WHERE workbook = $wb", {
      wb: new StringRecordId(workbook!.id),
    });
    expect(legacySheets).toHaveLength(1);
    expect(legacySheets[0]!.table_name).toMatch(/_main$/);
  }, 30_000);

  test("无效引用与字段类型在执行前失败，库内所有结构和记录保持原样", async () => {
    const { root, conn, template } = await setup();
    const before = await snapshot(root);
    const store = createWorkbooksStore({ getConn: () => conn });
    for (const column of [
      { key: "asset", label: "设备", fieldType: "reference", referenceSheetKey: "missing" },
      { key: "score", label: "评分", fieldType: "unsupported" },
    ]) {
      expect(await store.createFromTemplate({ ...template, sheets: [{ key: "checks", label: "巡检", columns: [column] }] })).toBeNull();
      expect(store.error).not.toBeNull();
      expect(await snapshot(root)).toEqual(before);
    }
  }, 30_000);

  test("最后一张表的样例类型错误回滚先前 DDL、元数据、样例与事件副作用", async () => {
    const { root, conn, template } = await setup();
    const before = await snapshot(root);
    const store = createWorkbooksStore({ getConn: () => conn });
    const sheets = structuredClone(template.sheets!);
    sheets[1]!.sampleRecords![0]!.values.score = "不是数字";
    expect(await store.createFromTemplate({ ...template, sheets })).toBeNull();
    expect(store.error).toContain("工作簿未创建");
    expect(await snapshot(root)).toEqual(before);
  }, 30_000);

  test("第二张表元数据冲突时回滚整个事务，包括已经定义的实体表", async () => {
    const { root, conn, template } = await setup();
    await root.query("CREATE sheet:3333333333333333 CONTENT { workbook: workbook:reserved, label: '预占', table_name: 'reserved', column_defs: [] }").collect();
    const before = await snapshot(root);
    const ids = ["1111111111111111", "2222222222222222", "3333333333333333"];
    const store = createWorkbooksStore({ getConn: () => conn, generateKey: () => ids.shift()! });
    expect(await store.createFromTemplate(template, undefined, { includeSampleData: false })).toBeNull();
    expect(await snapshot(root)).toEqual(before);
  }, 30_000);

  test("成员即使直接调用创建、携带 RL=Owner 也不能执行 DDL，中文报错且没有半成品", async () => {
    const { root, member, template } = await setup();
    const before = await snapshot(root);
    const store = createWorkbooksStore({ getConn: () => member });
    expect(await store.createFromTemplate(template)).toBeNull();
    expect(store.error).toContain("没有权限");
    expect(await store.createBlank("尝试绕过入口")).toBeNull();
    expect(store.error).toContain("没有权限");
    expect(await snapshot(root)).toEqual(before);
  }, 30_000);
});
