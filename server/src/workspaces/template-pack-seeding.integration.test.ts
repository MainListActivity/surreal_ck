import { describe, expect, test } from "bun:test";
import { Surreal, Table, DateTime } from "surrealdb";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { loadTemplatePackScripts } from "@surreal-ck/shared/template-packs";
import { homedir } from "node:os";

/**
 * CV-02 模板包数据文件与播种（真实 SurrealDB）：
 * 起独立内存实例，按 workspace 创建 lifecycle 的实际路径执行——先应用
 * workspace-template 全量增量链，再执行所选模板包数据文件，验证：
 * - 播种：包行全字段落库（两表形状/引用/别名/单选选项/领域提示/样例），
 *   样例类型合法且跨表引用可解析，性质与状态字段可直接作分组维度；
 * - 不播种：配置为空时不执行任何包文件，库内无模板行（空白工作簿可用）；
 * - 幂等：重复执行不产生重复 key，不覆盖未声明字段（管理员自定义保留）；
 * - 管理员安装：已有 workspace 管理员会话可增删模板行，key 唯一；
 * - 失败：执行失败不留半行，由 workspace 创建补偿兜底。
 */

async function spawnSurreal() {
  const port = 19000 + Math.floor(Math.random() * 10000);
  const password = crypto.randomUUID();
  const surrealBinary = process.env.SURREAL_BINARY ?? `${homedir()}/.surrealdb/surreal`;
  const proc = Bun.spawn(
    [surrealBinary, "start", "--allow-all", "--bind", `127.0.0.1:${port}`, "--user", "test", "--pass", password, "memory"],
    { stdout: "ignore", stderr: "ignore" },
  );
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) {
        return { url: `ws://127.0.0.1:${port}/rpc`, password, proc };
      }
    } catch { /* 等待启动 */ }
    await Bun.sleep(50);
  }
  proc.kill();
  throw new Error("local surrealdb failed to start");
}

const NS = "test";
const opened: Surreal[] = [];

function track<T extends Surreal>(db: T): T {
  opened.push(db);
  return db;
}

async function closeAll() {
  await Promise.allSettled(opened.splice(0).map((db) => db.close()));
}

async function openRoot(url: string, password: string, database: string) {
  const root = track(new Surreal());
  await root.connect(url);
  await root.signin({ username: "test", password });
  await root.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS}; USE NS ${NS}; DEFINE DATABASE IF NOT EXISTS ${database};`);
  await root.use({ namespace: NS, database });
  return root;
}

async function applyTemplateChain(root: Surreal) {
  for (const script of await loadTemplateScripts({ oidcJwksUrl: "http://127.0.0.1:65535/jwks" })) {
    await root.query(script.sql).collect();
  }
}

async function loadBankruptcyPack() {
  const [script] = await loadTemplatePackScripts({ selectedPacks: ["bankruptcy-claims"] });
  if (!script) throw new Error("bankruptcy-claims pack file missing");
  return script;
}

async function seedPack(root: Surreal) {
  const script = await loadBankruptcyPack();
  await root.query(script.sql).collect();
}

async function seedUsers(root: Surreal) {
  await root.insert(new Table("user"), [
    { id: "member", email: "member@example.com", kind: "human", is_admin: false },
    { id: "admin", email: "admin@example.com", kind: "human", is_admin: true },
  ]);
}

/** 测试实例内临时 RECORD access：与生产 $auth 落在 user 记录上的会话形态等价。 */
async function defineMemberAccess(root: Surreal) {
  await root.query(`
    DEFINE ACCESS OVERWRITE member_record ON DATABASE TYPE RECORD
      SIGNIN (SELECT * FROM user WHERE email = $email)
      DURATION FOR SESSION 1h;
  `).collect();
}

async function signin(url: string, database: string, email: string) {
  const db = track(new Surreal());
  await db.connect(url, { namespace: NS, database });
  await db.signin({ namespace: NS, database, access: "member_record", variables: { email } });
  return db;
}

type ColumnDef = {
  key: string;
  label: string;
  field_type: string;
  required?: boolean;
  options?: string[];
  constraints?: Record<string, unknown>;
  aliases?: string[];
  reference_sheet_key?: string;
  reference_display_key?: string;
};

type SampleRecord = { key: string; values: Record<string, unknown> };

type SheetDef = {
  key: string;
  label: string;
  column_defs: ColumnDef[];
  sample_records?: SampleRecord[];
};

type PackRow = {
  key: string;
  label: string;
  description?: string;
  default_name?: string;
  builtin: boolean;
  sort_order: number;
  sheet_defs: SheetDef[];
  quick_tasks?: Array<{ key: string; task_text: string; sheet_keys?: string[]; risk: string }>;
  row_analysis?: {
    background: string;
    field_semantics?: Array<{ field_key: string; meaning: string }>;
    review_points?: string[];
    output_guidance?: string[];
  };
  default_dashboard?: {
    slug: string;
    widgets: Array<{ id: string; viewType: string; spec: Record<string, unknown> }>;
  };
  check_rules?: unknown;
};

async function readPackRow(db: Surreal): Promise<PackRow | undefined> {
  const [rows] = await db
    .query<[PackRow[]]>('SELECT * FROM workbook_template WHERE key = "bankruptcy-claims"')
    .collect();
  return rows[0];
}

const VALID_DATE_VALUE = (value: unknown): boolean =>
  value instanceof DateTime
  || (typeof value === "string" && !Number.isNaN(Date.parse(value)));

/** 验收标准第一条：两表字段、引用、选项、别名、领域提示与类型合法的关联样例。 */
function assertPackShape(pack: PackRow) {
  expect(pack.key).toBe("bankruptcy-claims");
  expect(pack.label).toBe("破产债权管理");
  expect(pack.default_name).toBe("破产债权管理台账");
  expect(pack.builtin).toBe(true);

  expect(pack.sheet_defs.map((sheet) => sheet.key)).toEqual(["creditors", "claims"]);
  expect(pack.sheet_defs.map((sheet) => sheet.label)).toEqual(["债权人", "债权申报"]);

  const [creditors, claims] = pack.sheet_defs;

  expect(creditors!.column_defs.map((column) => column.key)).toEqual([
    "creditor_name",
    "identity_type",
    "identity_number",
    "contact_name",
    "contact_phone",
    "address",
  ]);
  for (const column of creditors!.column_defs) {
    expect(column.field_type).toBe("text");
    expect((column.aliases ?? []).length).toBeGreaterThan(0);
  }
  expect(creditors!.column_defs.filter((column) => column.required).map((column) => column.key)).toEqual([
    "creditor_name",
    "identity_type",
    "identity_number",
  ]);

  expect(claims!.column_defs.map((column) => column.key)).toEqual([
    "creditor",
    "declared_amount",
    "interest_amount",
    "claim_nature",
    "declared_date",
    "evidence_note",
    "review_status",
    "reviewed_amount",
    "review_opinion",
  ]);
  // 引用：债权申报 → 债权人，展示字段真实存在于债权人表。
  const references = claims!.column_defs.filter((column) => column.field_type === "reference");
  expect(references).toHaveLength(1);
  expect(references[0]).toEqual(expect.objectContaining({
    key: "creditor",
    required: true,
    reference_sheet_key: "creditors",
    reference_display_key: "creditor_name",
  }));
  expect(creditors!.column_defs.some((column) => column.key === "creditor_name")).toBe(true);

  // 单选字段（可作分组聚合维度）与常见 Excel 列别名。
  const nature = claims!.column_defs.find((column) => column.key === "claim_nature")!;
  const status = claims!.column_defs.find((column) => column.key === "review_status")!;
  expect(nature.field_type).toBe("single_select");
  expect(nature.options).toContain("普通债权");
  expect(nature.options).toContain("有财产担保债权");
  expect(nature.options).toContain("劳动债权");
  expect(nature.options).toContain("税款债权");
  expect(status.field_type).toBe("single_select");
  expect(status.options).toContain("待审查");
  expect(status.options).toContain("审查中");
  expect(status.options).toContain("已审定");
  for (const column of claims!.column_defs) {
    if (column.field_type !== "reference") {
      expect((column.aliases ?? []).length).toBeGreaterThan(0);
    }
  }

  // 领域提示（审查场景）。
  expect(pack.row_analysis?.background.length).toBeGreaterThan(0);
  expect((pack.row_analysis?.field_semantics ?? []).length).toBeGreaterThanOrEqual(5);
  expect((pack.row_analysis?.review_points ?? []).length).toBeGreaterThanOrEqual(3);
  expect((pack.row_analysis?.output_guidance ?? []).length).toBeGreaterThanOrEqual(1);

  // 快捷任务：全部指向模板内已声明的数据表。
  expect((pack.quick_tasks ?? []).length).toBeGreaterThanOrEqual(5);
  for (const task of pack.quick_tasks ?? []) {
    expect(["query", "write", "ddl"]).toContain(task.risk);
    for (const sheetKey of task.sheet_keys ?? []) {
      expect(pack.sheet_defs.map((sheet) => sheet.key)).toContain(sheetKey);
    }
  }

  // 默认仪表盘：统计口径全部基于模板内数据表。
  for (const widget of pack.default_dashboard?.widgets ?? []) {
    const spec = widget.spec as { sourceTables?: string[]; baseTable?: string };
    for (const table of [...(spec.sourceTables ?? []), ...(spec.baseTable ? [spec.baseTable] : [])]) {
      expect(pack.sheet_defs.map((sheet) => sheet.key)).toContain(table);
    }
  }

  // 样例：数个债权人 + 十余笔申报，类型合法且引用可解析。
  const creditorSamples = creditors!.sample_records ?? [];
  const claimSamples = claims!.sample_records ?? [];
  expect(creditorSamples.length).toBeGreaterThanOrEqual(5);
  expect(claimSamples.length).toBeGreaterThanOrEqual(10);
  const creditorKeys = new Set(creditorSamples.map((sample) => sample.key));
  const creditorColumnKeys = new Set(creditors!.column_defs.map((column) => column.key));
  for (const sample of creditorSamples) {
    for (const [field, value] of Object.entries(sample.values)) {
      expect(creditorColumnKeys.has(field)).toBe(true);
      if (typeof value === "number") expect(value).toBeGreaterThanOrEqual(0);
    }
  }
  const claimsColumnKeys = new Set(claims!.column_defs.map((column) => column.key));
  const optionsByKey = new Map(
    claims!.column_defs.filter((column) => column.field_type === "single_select")
      .map((column) => [column.key, new Set(column.options ?? [])]),
  );
  for (const sample of claimSamples) {
    for (const [field, value] of Object.entries(sample.values)) {
      expect(claimsColumnKeys.has(field)).toBe(true);
      if (field === "creditor") {
        expect(value).toEqual(
          expect.objectContaining({ sheet_key: "creditors", record_key: expect.any(String) }),
        );
        expect(creditorKeys.has((value as { record_key: string }).record_key)).toBe(true);
      } else if (optionsByKey.has(field)) {
        expect((optionsByKey.get(field) as Set<string>).has(String(value))).toBe(true);
      } else if (["declared_amount", "interest_amount", "reviewed_amount"].includes(field)) {
        expect(typeof value).toBe("number");
        expect(value).toBeGreaterThanOrEqual(0);
      } else if (field === "declared_date") {
        expect(VALID_DATE_VALUE(value)).toBe(true);
      }
    }
  }
  // 已审定/部分审定样例带审定金额；未审定的样例不带。
  for (const sample of claimSamples) {
    const status = String(sample.values.review_status);
    const reviewed = sample.values.reviewed_amount;
    if (status === "已审定" || status === "部分审定") {
      expect(typeof reviewed).toBe("number");
    } else {
      expect(reviewed).toBeUndefined();
    }
  }
}

describe("CV-02 模板包数据文件与播种（真实 SurrealDB）", () => {
  test("播种后包行全字段落库，引用与样例类型合法，聚合字段可分组", async () => {
    const { url, password, proc } = await spawnSurreal();
    const database = `cv02_seed_${Date.now().toString(36)}`;
    try {
      const root = await openRoot(url, password, database);
      await applyTemplateChain(root);
      await seedPack(root);

      assertPackShape((await readPackRow(root))!);
    } finally {
      await closeAll();
      proc.kill();
    }
  }, 30_000);

  test("配置为空时不播种：库内无任何模板行，空白工作簿可用", async () => {
    const { url, password, proc } = await spawnSurreal();
    const database = `cv02_noseed_${Date.now().toString(36)}`;
    try {
      const root = await openRoot(url, password, database);
      await applyTemplateChain(root);

      // 空选择不加载任何包文件。
      expect(await loadTemplatePackScripts({ selectedPacks: [] })).toEqual([]);

      const [rows] = await root.query<[Array<{ key: string }>]>("SELECT key FROM workbook_template").collect();
      expect(rows).toEqual([]);
    } finally {
      await closeAll();
      proc.kill();
    }
  }, 30_000);

  test("播种幂等：不产生重复 key，不覆盖未声明的管理员自定义字段", async () => {
    const { url, password, proc } = await spawnSurreal();
    const database = `cv02_idempotent_${Date.now().toString(36)}`;
    try {
      const root = await openRoot(url, password, database);
      await applyTemplateChain(root);
      await seedUsers(root);
      await defineMemberAccess(root);
      await seedPack(root);
      const firstPass = (await readPackRow(root))!;

      // 管理员在已有 workspace 上的自定义：改 check_rules（包未声明该字段）、
      // 另建一个自有模板行。
      const admin = await signin(url, database, "admin@example.com");
      await admin.query(`
        UPDATE workbook_template SET
          check_rules = { version: "v1", rules: [] }
        WHERE key = "bankruptcy-claims";
      `).collect();
      await admin.insert(new Table("workbook_template"), {
        key: "admin-custom",
        label: "管理员自定义模板",
        sheet_defs: [{ key: "main", label: "主表", column_defs: [] }],
      });

      // 管理员重跑同一份数据文件（升级路径）。
      await seedPack(root);

      const [rows] = await root.query<[Array<{ key: string }>]>("SELECT key FROM workbook_template ORDER BY key").collect();
      expect(rows.map((row) => row.key)).toEqual(["admin-custom", "bankruptcy-claims"]);

      const repacked = (await readPackRow(root))!;
      expect(repacked.sheet_defs).toEqual(firstPass.sheet_defs);
      expect(repacked.quick_tasks).toEqual(firstPass.quick_tasks);
      // 未声明字段不被覆盖。
      expect(repacked.check_rules).toEqual({ version: "v1", rules: [] });
      // 管理员自定义模板行不受包重跑影响。
      const [customRows] = await admin
        .query<[Array<{ label: string }>]>("SELECT label FROM workbook_template WHERE key = 'admin-custom'")
        .collect();
      expect(customRows?.[0]?.label).toBe("管理员自定义模板");

      // 普通成员只读（CV-01 契约在包行上同样成立）。
      const member = await signin(url, database, "member@example.com");
      const inserted = await member.insert(new Table("workbook_template"), { key: "forbidden", label: "x" });
      expect(inserted).toEqual([]);

      // 移除路径：管理员删除模板行后法律内容整体消失，库结构不受影响。
      await admin.query('DELETE workbook_template WHERE key = "bankruptcy-claims"').collect();
      const [remaining] = await root.query<[Array<{ key: string }>]>("SELECT key FROM workbook_template ORDER BY key").collect();
      expect(remaining.map((row) => row.key)).toEqual(["admin-custom"]);
      const [info] = await root.query<[Record<string, unknown>]>("INFO FOR TABLE workbook_template").collect();
      expect(info).toBeDefined();
    } finally {
      await closeAll();
      proc.kill();
    }
  }, 30_000);

  test("包执行失败不留半行：workspace 创建补偿语义在数据层面的等价物", async () => {
    const { url, password, proc } = await spawnSurreal();
    const database = `cv02_failure_${Date.now().toString(36)}`;
    try {
      const root = await openRoot(url, password, database);
      await applyTemplateChain(root);

      // 模拟非法包：SCHEMAFULL 拒绝未声明顶层字段，整个 INSERT 不落任何行。
      await expect(root.query(`
        INSERT INTO workbook_template [
          { key: "broken-pack", label: "非法包", undeclared_top_field: "nope" },
        ];
      `).collect()).rejects.toBeInstanceOf(Error);
      const [rows] = await root.query<[Array<{ key: string }>]>("SELECT key FROM workbook_template").collect();
      expect(rows).toEqual([]);

      // 未知包名在加载期即报明确错误，不产生任何数据库写入。
      await expect(
        loadTemplatePackScripts({ selectedPacks: ["missing-pack"] }),
      ).rejects.toThrow("unknown template pack: missing-pack");
    } finally {
      await closeAll();
      proc.kill();
    }
  }, 30_000);
});
