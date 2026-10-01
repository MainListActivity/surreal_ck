import { afterEach, describe, expect, test } from "bun:test";
import { Surreal } from "surrealdb";
import { listClaimsRiskEmployees } from "./claims-risk-dispatcher";
import type { getRootDatabaseSession } from "../../src/db/root-connection";

const localSurrealTest = test.skipIf(process.env.RUN_LOCAL_SURREALDB_TESTS !== "1");
const opened: Surreal[] = [];

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((db) => db.close()));
});

const url = process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
const namespace = process.env.LOCAL_SURREAL_NS ?? "main";
const authentication = {
  username: process.env.LOCAL_SURREAL_ROOT_USER ?? "root",
  password: process.env.LOCAL_SURREAL_ROOT_PASS ?? "root",
};

async function connect(database: string): Promise<Surreal> {
  const db = new Surreal();
  opened.push(db);
  await db.connect(url, { authentication, namespace });
  await db.use({ namespace, database });
  return db;
}

describe("CV01/CV05 债权提醒门控（真实引擎）", () => {
  localSurrealTest("通用/未启用/模板缺失的 workspace 不 provision 员工，启用债权包的工作区才投递", async () => {
    const suffix = Date.now().toString(36);
    const databases = {
      generic: `gate_generic_${suffix}`,
      disabled: `gate_disabled_${suffix}`,
      enabled: `gate_enabled_${suffix}`,
    };
    const bootstrap = await connect(namespace);
    for (const db of Object.values(databases)) {
      await bootstrap.query(`DEFINE DATABASE IF NOT EXISTS ${db}`).collect();
    }
    await bootstrap.query(`DEFINE DATABASE IF NOT EXISTS _system`).collect();
    await bootstrap.use({ namespace, database: "_system" });
    await bootstrap.query(`
      DEFINE TABLE IF NOT EXISTS workspace SCHEMALESS PERMISSIONS FULL;
      DELETE FROM workspace WHERE id IN [workspace:gate_${suffix}_g, workspace:gate_${suffix}_d, workspace:gate_${suffix}_e];
      INSERT INTO workspace [
        { id: workspace:gate_${suffix}_g, db_name: "${databases.generic}", status: "active" },
        { id: workspace:gate_${suffix}_d, db_name: "${databases.disabled}", status: "active" },
        { id: workspace:gate_${suffix}_e, db_name: "${databases.enabled}", status: "active" }
      ];
    `).collect();

    const workspaceShape = `
      DEFINE TABLE workbook_template SCHEMALESS PERMISSIONS FULL;
      DEFINE TABLE workbook SCHEMALESS PERMISSIONS FULL;
      DEFINE TABLE user SCHEMALESS PERMISSIONS FULL;
      DEFINE TABLE employee_credential SCHEMALESS PERMISSIONS FULL;
      DEFINE INDEX IF NOT EXISTS employee_credential_employee_unique
        ON TABLE employee_credential COLUMNS employee UNIQUE;
    `;
    for (const db of Object.values(databases)) {
      const ws = await connect(db);
      await ws.query(workspaceShape).collect();
    }

    // 通用包且开启了提醒字段——flag 打开但非债权包，不应命中。
    const generic = await connect(databases.generic);
    await generic.query(`
      CREATE workbook_template:equipment CONTENT { key: "equipment" };
      CREATE workbook:w1 CONTENT { name: "设备台账", template: workbook_template:equipment, risk_reminders_enabled: true };
    `).collect();

    // 债权包已实例化但提醒未启用——不得 provision。
    const disabled = await connect(databases.disabled);
    await disabled.query(`
      CREATE workbook_template:claims CONTENT { key: "bankruptcy-claims" };
      CREATE workbook:w1 CONTENT { name: "债权台账", template: workbook_template:claims, risk_reminders_enabled: false };
    `).collect();

    // 启用态：唯一应进入名单的 workspace。
    const enabled = await connect(databases.enabled);
    await enabled.query(`
      CREATE workbook_template:claims CONTENT { key: "bankruptcy-claims" };
      CREATE workbook:w1 CONTENT { name: "债权台账", template: workbook_template:claims, risk_reminders_enabled: true };
    `).collect();

    const targets = await listClaimsRiskEmployees(
      connect as unknown as typeof getRootDatabaseSession,
    );

    expect(targets).toEqual([{
      database: databases.enabled,
      employeeId: "user:claims_risk_reminder",
    }]);

    // 零尾迹：通用与未启用 workspace 不得出现 claims 员工或凭证。
    for (const db of [databases.generic, databases.disabled]) {
      const ws = await connect(db);
      const [users] = await ws.query<[{ id: unknown }[]]>("SELECT id FROM user").collect();
      const [creds] = await ws.query<[{ id: unknown }[]]>("SELECT id FROM employee_credential").collect();
      expect(users).toEqual([]);
      expect(creds).toEqual([]);
    }

    const [employees] = await enabled.query<[{ id: unknown }[]]>(
      "SELECT id FROM user WHERE id = user:claims_risk_reminder",
    ).collect();
    const [credentials] = await enabled.query<[{ secret?: unknown }[]]>(
      "SELECT secret FROM employee_credential",
    ).collect();
    expect(employees).toHaveLength(1);
    expect(credentials).toHaveLength(1);
    expect(typeof credentials[0]?.secret).toBe("string");

    // 幂等：第二次枚举复用既有员工与凭证，不新增行。
    const second = await listClaimsRiskEmployees(
      connect as unknown as typeof getRootDatabaseSession,
    );
    expect(second).toEqual(targets);
    const [userCount] = await enabled.query<[{ count: number }[]]>(
      "SELECT count() FROM user GROUP ALL",
    ).collect();
    const [credCount] = await enabled.query<[{ count: number }[]]>(
      "SELECT count() FROM employee_credential GROUP ALL",
    ).collect();
    expect(userCount[0]?.count).toBe(1);
    expect(credCount[0]?.count).toBe(1);
  });
});
