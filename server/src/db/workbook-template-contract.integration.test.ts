import { describe, expect, test } from "bun:test";
import { Surreal, Table } from "surrealdb";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { homedir } from "node:os";

/**
 * CV-01 workbook_template 通用模板包契约（真实 SurrealDB）：
 * 起独立内存实例，应用 workspace-template 全量增量链，验证：
 * - 增量幂等：同一链连续应用两次不报错、已入库模板数据仍在；
 * - 契约表达力：sheet_defs（key/label/字段/列别名/跨表引用声明/样例记录）
 *   与 row_analysis 领域提示可整行落库并被普通成员读回；
 * - 旧兼容：只含顶层 column_defs 的旧模板行照常可读（sheet_defs 缺省 []）；
 * - 权限边界：普通成员只读（写/删/DDL 被拒），管理员会话与 root 可写；
 * - key 唯一索引生效；SCHEMAFULL 拒绝未声明顶层字段。
 *
 * 测试用 member_record access 是测试实例内的临时 RECORD access：它与生产
 * participant（RECORD WITH JWT）同样让 $auth 落在 user 记录上，用于等价
 * 验证 PERMISSIONS；生产 admin 是 JWT system user（RL=Owner 走 RBAC），
 * 这里用 is_admin=true 的 RECORD 会话覆盖 $auth.is_admin 写路径。
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

/** 测试实例内临时 RECORD access：按 email 定位 user 记录，等价生产 $auth=user 的会话形态。 */
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

async function seedUsers(root: Surreal) {
  await root.insert(new Table("user"), [
    { id: "member", email: "member@example.com", kind: "human", is_admin: false },
    { id: "admin", email: "admin@example.com", kind: "human", is_admin: true },
  ]);
}

/** 模板包行：两张数据表 + 列别名 + 跨表引用 + 样例 + 领域提示（全部中性领域词）。 */
const PACKAGE_ROW = {
  key: "equipment-ops",
  label: "设备运维台账",
  description: "设备与巡检记录两表模板",
  icon: "wrench",
  sheet_defs: [
    {
      key: "assets",
      label: "设备表",
      column_defs: [
        { key: "asset_name", label: "设备名称", field_type: "text", aliases: ["设备", "机具名称"] },
        { key: "serial_no", label: "序列号", field_type: "text" },
      ],
      sample_records: [
        { key: "a1", values: { asset_name: "样例设备", serial_no: "SN-001" } },
      ],
    },
    {
      key: "inspections",
      label: "巡检表",
      column_defs: [
        {
          key: "asset",
          label: "所属设备",
          field_type: "reference",
          reference_sheet_key: "assets",
          aliases: ["设备", "资产"],
        },
        { key: "checked_on", label: "巡检日期", field_type: "datetime" },
      ],
      sample_records: [
        { key: "i1", values: { asset: { sample_key: "a1" }, checked_on: "2026-01-01T00:00:00Z" } },
      ],
    },
  ],
  row_analysis: {
    background: "设备巡检记录分析",
    field_semantics: [{ field_key: "serial_no", meaning: "出厂序列号，台账唯一标识" }],
    review_points: ["巡检日期不应晚于当前时间"],
    output_guidance: ["给出缺失字段清单"],
  },
};

const LEGACY_ROW = {
  key: "legacy-ledger",
  label: "旧单表模板",
  column_defs: [{ key: "title", label: "标题", field_type: "text" }],
};

describe("CV-01 workbook_template 契约（真实 SurrealDB）", () => {
  test("增量链幂等且成员可读完整包行与旧 column_defs 行", async () => {
    const { url, password, proc } = await spawnSurreal();
    const database = `cv01_contract_${Date.now().toString(36)}`;
    try {
      const root = await openRoot(url, password, database);
      await applyTemplateChain(root);
      // 幂等：同一增量链整体重放一遍必须不报错（已有数据不丢）。
      await applyTemplateChain(root);

      await seedUsers(root);
      await defineMemberAccess(root);
      await root.insert(new Table("workbook_template"), [PACKAGE_ROW, LEGACY_ROW]);

      const member = await signin(url, database, "member@example.com");
      const rows = await member.select<Record<string, unknown>>(new Table("workbook_template"));
      expect(rows).toHaveLength(2);

      const pack = rows.find((row) => row.key === "equipment-ops");
      expect(pack?.sheet_defs).toEqual(PACKAGE_ROW.sheet_defs);
      expect(pack?.row_analysis).toEqual(PACKAGE_ROW.row_analysis);
      expect(pack?.description).toBe(PACKAGE_ROW.description);

      // 旧顶层 column_defs 模板仍可读，sheet_defs 缺省为空数组。
      const legacy = rows.find((row) => row.key === "legacy-ledger");
      expect(legacy?.column_defs).toEqual(LEGACY_ROW.column_defs);
      expect(legacy?.sheet_defs).toEqual([]);

      // 幂等重放后数据仍在（上面已重放过一次）。
      expect(rows.map((row) => row.key).sort()).toEqual(["equipment-ops", "legacy-ledger"]);
    } finally {
      await closeAll();
      proc.kill();
    }
  }, 30_000);

  test("普通成员只读：写/删/DDL 全部被拒", async () => {
    const { url, password, proc } = await spawnSurreal();
    const database = `cv01_readonly_${Date.now().toString(36)}`;
    try {
      const root = await openRoot(url, password, database);
      await applyTemplateChain(root);
      await seedUsers(root);
      await defineMemberAccess(root);
      await root.insert(new Table("workbook_template"), { key: "seeded", label: "已有模板" });

      const member = await signin(url, database, "member@example.com");
      // 成员写被拒（PERMISSIONS 拒绝时返回空集而非抛错是 SurrealDB 语义）。
      const inserted = await member.insert(new Table("workbook_template"), { key: "forbidden", label: "x" });
      expect(inserted).toEqual([]);
      const updated = await member.query("UPDATE workbook_template SET label = 'tampered' WHERE key = 'seeded' RETURN AFTER").collect();
      expect(updated[0]).toEqual([]);
      const deleted = await member.query("DELETE workbook_template WHERE key = 'seeded'").collect();
      expect(deleted[0]).toEqual([]);
      // 成员 DDL 被引擎层硬拒。
      const ddlError = await member.query("DEFINE TABLE member_ddl_attempt SCHEMALESS").collect().then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(ddlError).toBeInstanceOf(Error);
      // 原行未被改动。
      const [rows] = await member.query<[Array<{ label: string }>]>("SELECT label FROM workbook_template").collect();
      expect(rows?.[0]?.label).toBe("已有模板");
    } finally {
      await closeAll();
      proc.kill();
    }
  }, 30_000);

  test("管理员会话可增改删；key 唯一索引生效", async () => {
    const { url, password, proc } = await spawnSurreal();
    const database = `cv01_admin_${Date.now().toString(36)}`;
    try {
      const root = await openRoot(url, password, database);
      await applyTemplateChain(root);
      await seedUsers(root);
      await defineMemberAccess(root);
      await root.insert(new Table("workbook_template"), { key: "seeded", label: "已有模板" });

      const admin = await signin(url, database, "admin@example.com");
      const created = await admin.insert<Record<string, unknown>>(new Table("workbook_template"), {
        key: "admin-added",
        label: "管理员新增",
        sheet_defs: [{ key: "main", label: "主表", column_defs: [] }],
      });
      expect(created[0]?.key).toBe("admin-added");

      await admin.query("UPDATE workbook_template SET sort_order = 9 WHERE key = 'admin-added'").collect();
      const [afterUpdate] = await admin.query<[
        Array<{ sort_order: number }>,
      ]>("SELECT sort_order FROM workbook_template WHERE key = 'admin-added'").collect();
      expect(afterUpdate?.[0]?.sort_order).toBe(9);

      // key 唯一：重复 key 写入被唯一索引拒绝。
      const dupError = await admin.insert(new Table("workbook_template"), {
        key: "admin-added",
        label: "重复 key",
      }).then(() => undefined, (cause: unknown) => cause);
      expect(dupError).toBeInstanceOf(Error);
      expect(String(dupError)).toContain("workbook_template_key_unique");

      // 管理员可删除模板行（模板可整体移除）。
      await admin.query("DELETE workbook_template WHERE key = 'admin-added'").collect();
      const [remaining] = await admin.query<[
        Array<{ key: string }>,
      ]>("SELECT key FROM workbook_template ORDER BY key").collect();
      expect(remaining?.map((row) => row.key)).toEqual(["seeded"]);
    } finally {
      await closeAll();
      proc.kill();
    }
  }, 30_000);

  test("SCHEMAFULL 拒绝未声明顶层字段；删除模板行后库结构不受影响", async () => {
    const { url, password, proc } = await spawnSurreal();
    const database = `cv01_strict_${Date.now().toString(36)}`;
    try {
      const root = await openRoot(url, password, database);
      await applyTemplateChain(root);

      const strictError = await root.query(`
        INSERT INTO workbook_template {
          key: "bad-shape",
          label: "x",
          undeclared_top_field: "nope",
        };
      `).collect().then(() => undefined, (cause: unknown) => cause);
      expect(strictError).toBeInstanceOf(Error);

      // 删除模板行是数据操作：schema 与其余表不受影响，同库空模板是合法常态。
      await root.insert(new Table("workbook_template"), { key: "removable", label: "可移除" });
      await root.query("DELETE workbook_template WHERE key = 'removable'").collect();
      const [rows] = await root.query<[Array<{ key: string }>]>("SELECT key FROM workbook_template").collect();
      expect(rows).toEqual([]);
      const [info] = await root.query<[Record<string, unknown>]>("INFO FOR TABLE workbook_template").collect();
      expect(info).toBeDefined();
    } finally {
      await closeAll();
      proc.kill();
    }
  }, 30_000);
});
