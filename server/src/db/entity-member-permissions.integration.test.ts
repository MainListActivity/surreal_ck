import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { Surreal } from "surrealdb";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { ENTITY_TABLE_MEMBER_PERMISSIONS } from "@surreal-ck/shared/entity-table-permissions";
import { materializeWorkspaceMigrationSql } from "./workspace-migration-execution";

/**
 * CV03 返工：实体表成员 DML 权限在公司 fork 上的真实引擎验证。
 *
 * 本机 fork 二进制未编 jwks feature，participant/admin 的 JWT authenticate
 * 在本地不可用；成员语义由 `member_test` RECORD access（email → user 查表）
 * 与真实 `employee` access（subject+secret）验证——两者最终都落 $auth=user
 * record，PERMISSIONS 判定与 participant JWT 会话完全等价。CI 里由
 * template-creation.integration.test.ts 跑真实 participant JWT 路径。
 */
const namespace = "perm_it";
const sessions: Surreal[] = [];
const password = crypto.randomUUID();
let endpoint = "";
let processHandle: ReturnType<typeof Bun.spawn> | null = null;
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

async function open(): Promise<Surreal> {
  const db = new Surreal();
  sessions.push(db);
  await db.connect(endpoint);
  return db;
}

async function memberSession(database: string, email: string): Promise<Surreal> {
  const db = await open();
  await db.signin({
    namespace,
    database,
    access: "member_test",
    variables: { email },
  });
  return db;
}

/** 建库 + 全套 workspace schema + member_test access + 三个成员用户。 */
async function setupWorkspace(): Promise<{ root: Surreal; database: string }> {
  const database = `ws_${sequence++}`;
  const root = await open();
  await root.signin({ username: "test", password });
  await root.use({ namespace, database });
  for (const script of await loadTemplateScripts({ oidcJwksUrl: "http://127.0.0.1:9/jwks" })) {
    await root.query(script.sql).collect();
  }
  // 测试专用 RECORD access：email 定位成员 user，等价 participant 的 $auth 形态。
  await root.query(`
    DEFINE ACCESS OVERWRITE member_test ON DATABASE TYPE RECORD
      SIGNIN (SELECT * FROM user WHERE email = $email LIMIT 1)
      DURATION FOR SESSION 1h;
    CREATE user CONTENT { subject: "m1", email: "member@test", kind: "human", is_admin: false };
    CREATE user CONTENT { subject: "v1", email: "virtual@test", kind: "virtual", is_admin: false, virtual_profile: { status: "active" } };
    UPDATE workspace_resource_quota:current SET plan = resource_quota_plan:max;
  `).collect();
  return { root, database };
}

async function queryRows(db: Surreal, sql: string): Promise<unknown[]> {
  const result = await db.query(sql).collect();
  const first = result[0];
  return Array.isArray(first) ? first : [];
}

async function expectDenied(db: Surreal, sql: string): Promise<void> {
  await expect(db.query(sql).collect()).rejects.toThrow();
}

describe("实体表成员 DML 权限（fork 真机）", () => {
  beforeAll(async () => {
    const port = await freePort();
    endpoint = `ws://127.0.0.1:${port}/rpc`;
    processHandle = Bun.spawn([
      process.env.SURREAL_BINARY ?? `${homedir()}/.surrealdb/surreal`,
      "start", "--allow-all", "--bind", `127.0.0.1:${port}`,
      "--user", "test", "--pass", password, "memory",
    ], { stdout: "ignore", stderr: "ignore" });
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
      } catch { /* 启动等待 */ }
      await Bun.sleep(50);
    }
    throw new Error("isolated SurrealDB failed to start");
  }, 20_000);

  afterAll(async () => {
    await Promise.allSettled(sessions.map((db) => db.close()));
    processHandle?.kill();
    if (processHandle) await processHandle.exited;
  });

  test("无 PERMISSIONS 既有表：成员读写全部落空（生产缺陷复现），043 迁移回填后可读写", async () => {
    const { root, database } = await setupWorkspace();
    // 生产缺陷形态：已登记 sheet 的实体表无 PERMISSIONS + 既有数据行。
    await root.query(`
      DEFINE TABLE ent_cv06_claims SCHEMALESS CHANGEFEED 7d;
      INSERT INTO ent_cv06_claims [{ name: "债权 A" }, { name: "债权 B" }];
      CREATE sheet:regr CONTENT { workbook: workbook:wb, label: "申报", table_name: "ent_cv06_claims", column_defs: [] };
      DEFINE TABLE ent_custom SCHEMALESS PERMISSIONS FOR select WHERE $auth != NONE;
      CREATE sheet:custom CONTENT { workbook: workbook:wb, label: "自定义", table_name: "ent_custom", column_defs: [] };
      DEFINE TABLE ent_unregistered SCHEMALESS;
    `).collect();
    const member = await memberSession(database, "member@test");

    // 复现：无 PERMISSIONS 表上成员读写不落库（静默空结果）。
    expect(await queryRows(member, "SELECT * FROM ent_cv06_claims")).toHaveLength(0);
    await member.query(`INSERT INTO ent_cv06_claims { name: "不落库" }`).collect();
    expect(await queryRows(root, "SELECT * FROM ent_cv06_claims")).toHaveLength(2);

    // 迁移物化：INFO 先行，custom 权限与未登记表不动。
    const migration = { version: 43, name: "043-entity-member-permissions.surql", sql: "-- marker" };
    const sql = await materializeWorkspaceMigrationSql(root, migration);
    expect(sql).toContain("ALTER TABLE ent_cv06_claims PERMISSIONS");
    expect(sql).not.toContain("ALTER TABLE ent_custom");
    expect(sql).not.toContain("ent_unregistered");
    await root.query(sql).collect();

    // 既有表读回：原行不丢，成员可查可写可改可删。
    const rows = await queryRows(member, "SELECT * FROM ent_cv06_claims ORDER BY name");
    expect(rows).toHaveLength(2);
    const created = await queryRows(member, `CREATE ent_cv06_claims CONTENT { name: "成员新增" }`);
    expect(created).toHaveLength(1);
    const createdId = (created[0] as { id: unknown }).id;
    expect(await queryRows(member, `UPDATE ${String(createdId)} SET name = "成员改"`)).toHaveLength(1);
    await member.query(`DELETE ${String(createdId)}`).collect();
    expect(await queryRows(root, "SELECT * FROM ent_cv06_claims")).toHaveLength(2);

    // custom 权限表保留原策略：成员仍只能 select（create/update/delete NONE）。
    expect(await queryRows(member, "SELECT * FROM ent_custom")).toHaveLength(0);
    await member.query(`INSERT INTO ent_custom { name: "越权" }`).collect();
    expect(await queryRows(root, "SELECT * FROM ent_custom")).toHaveLength(0);

    // 未登记表不受迁移影响。
    expect(await queryRows(member, "SELECT * FROM ent_unregistered")).toHaveLength(0);

    // 幂等重跑：已带本迁移权限的表识别为已应用，产出 no-op 标记，权限定义不漂移。
    const second = await materializeWorkspaceMigrationSql(root, migration);
    expect(second).not.toContain("ALTER TABLE");
    expect(second).toContain("RETURN");
    await root.query(second).collect();
    expect(await queryRows(member, "SELECT * FROM ent_cv06_claims")).toHaveLength(2);

    // AC5 配额回归：迁移后 sheet 配额守卫仍生效——第 4 张 sheet（max=3）
    // 被 THROW 拒绝且记录不落库（写操作原子回滚）。
    await root.query(`
      CREATE sheet:q3 CONTENT { workbook: workbook:wb, label: "三号", table_name: "ent_q3", column_defs: [] };
    `).collect();
    await expectDenied(root, `
      CREATE sheet:q4 CONTENT { workbook: workbook:wb, label: "四号", table_name: "ent_q4", column_defs: [] };
    `);
    expect(await queryRows(root, "SELECT * FROM sheet:q4")).toHaveLength(0);
  }, 30_000);

  test("新建实体表权限子句：成员 CRUD、活动审计归因、DDL 拒绝、移除即收回", async () => {
    const { root, database } = await setupWorkspace();
    // 与 workbooks.ts 建表事务相同的实体表定义形态（同一共享谓词常量）。
    await root.query(`
      DEFINE TABLE ent_fresh SCHEMALESS CHANGEFEED 7d ${ENTITY_TABLE_MEMBER_PERMISSIONS};
      DEFINE FIELD IF NOT EXISTS created_at ON TABLE ent_fresh TYPE datetime VALUE time::now() READONLY;
      DEFINE FIELD IF NOT EXISTS updated_at ON TABLE ent_fresh TYPE datetime VALUE time::now();
      DEFINE FIELD IF NOT EXISTS name ON TABLE ent_fresh TYPE string;
      DEFINE EVENT OVERWRITE record_activity ON TABLE ent_fresh WHEN $event = "CREATE" OR $event = "UPDATE" OR $event = "DELETE" THEN {
        LET $verb = IF $event = "DELETE" { "record.delete" } ELSE { "record.write" };
        LET $rec = IF $event = "DELETE" { $before } ELSE { $after };
        CREATE activity_event CONTENT { verb: $verb, target_kind: "record", target: $rec.id };
      };
    `).collect();
    const member = await memberSession(database, "member@test");

    // AC1：成员完整 DML + 回读。
    const created = await queryRows(member, `CREATE ent_fresh CONTENT { name: "一行" }`);
    expect(created).toHaveLength(1);
    const rowId = (created[0] as { id: unknown }).id;
    expect((created[0] as { created_at?: unknown }).created_at).toBeTruthy();
    expect(await queryRows(member, "SELECT * FROM ent_fresh")).toHaveLength(1);
    expect(await queryRows(member, `UPDATE ${String(rowId)} SET name = "改名"`)).toHaveLength(1);
    await member.query(`DELETE ${String(rowId)}`).collect();
    expect(await queryRows(member, "SELECT * FROM ent_fresh")).toHaveLength(0);

    // 活动审计：事件以引擎特权写 activity_event，actor 归因到成员 user。
    const activity = await queryRows(root,
      "SELECT * FROM activity_event WHERE target_kind = \"record\" ORDER BY created_at");
    expect(activity.length).toBeGreaterThanOrEqual(3); // write + write + delete
    const memberRecord = (await queryRows(root,
      "SELECT VALUE id FROM user WHERE subject = \"m1\""))[0];
    expect((activity[0] as { actor?: unknown }).actor).toBeTruthy();
    expect(String((activity[0] as { actor?: unknown }).actor)).toBe(String(memberRecord));

    // AC3：成员 DDL / ALTER / REMOVE 全部被 access 类型硬拒。
    await expectDenied(member, "DEFINE TABLE ent_evil SCHEMALESS");
    await expectDenied(member, `ALTER TABLE ent_fresh ${ENTITY_TABLE_MEMBER_PERMISSIONS.replace("FOR select, create, update, delete", "FULL")}`);
    await expectDenied(member, "REMOVE TABLE ent_fresh");

    // AC4：disabled_at 置位后，既有会话立即失去读写（不等 token 到期）。
    await root.query(`UPDATE user SET disabled_at = time::now() WHERE subject = "m1"`).collect();
    expect(await queryRows(member, "SELECT * FROM ent_fresh")).toHaveLength(0);
    await member.query(`CREATE ent_fresh CONTENT { name: "被移除后写" }`).collect();
    expect(await queryRows(root, "SELECT * FROM ent_fresh")).toHaveLength(0);
    await root.query(`UPDATE user SET disabled_at = NONE WHERE subject = "m1"`).collect();
    expect(await queryRows(member, "SELECT * FROM ent_fresh")).toHaveLength(0);

    // employee（虚拟员工，kind=virtual）：与静态业务表同口径，活跃员工有成员级 DML。
    const employee = await memberSession(database, "virtual@test");
    const employeeRow = await queryRows(employee, `CREATE ent_fresh CONTENT { name: "员工写" }`);
    expect(employeeRow).toHaveLength(1);
    await member.query(`DELETE ${String((employeeRow[0] as { id: unknown }).id)}`).collect();
  }, 30_000);

  test("043 迁移对全量真实 schema 可重入：空工作区返回 no-op 标记", async () => {
    const { root } = await setupWorkspace();
    const sql = await materializeWorkspaceMigrationSql(
      root,
      { version: 43, name: "043-entity-member-permissions.surql", sql: "-- marker" },
    );
    expect(sql).toContain("RETURN");
    expect(sql).not.toContain("ALTER TABLE");
    await root.query(sql).collect();
  }, 30_000);
});
