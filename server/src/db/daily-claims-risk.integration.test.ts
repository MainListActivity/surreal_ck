import { afterEach, describe, expect, test } from "bun:test";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { StringRecordId, Surreal } from "surrealdb";

const localSurrealTest = test.skipIf(process.env.RUN_LOCAL_SURREALDB_TESTS !== "1");
const opened: Surreal[] = [];

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((db) => db.close()));
});

describe("OIP-18 风险提醒 SurrealDB access contract", () => {
  localSurrealTest("employee 可写且唯一索引去重，目标真人可读和解决提醒", async () => {
    const url = process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
    const namespace = process.env.LOCAL_SURREAL_NS ?? "main";
    const database = `claims_risk_${Date.now().toString(36)}`;
    const root = new Surreal();
    opened.push(root);
    await root.connect(url, {
      authentication: {
        username: process.env.LOCAL_SURREAL_ROOT_USER ?? "root",
        password: process.env.LOCAL_SURREAL_ROOT_PASS ?? "root",
      },
      namespace,
      database,
    });
    await root.query(`
      DEFINE TABLE user SCHEMAFULL PERMISSIONS FULL;
      DEFINE FIELD email ON TABLE user TYPE string;
      DEFINE FIELD password ON TABLE user TYPE option<string>;
      DEFINE FIELD subject ON TABLE user TYPE option<string>;
      DEFINE FIELD kind ON TABLE user TYPE string;
      DEFINE FIELD is_admin ON TABLE user TYPE bool DEFAULT false;
      DEFINE FIELD disabled_at ON TABLE user TYPE option<datetime>;
      DEFINE FIELD created_at ON TABLE user TYPE datetime VALUE time::now();
      DEFINE TABLE employee_credential SCHEMAFULL PERMISSIONS NONE;
      DEFINE FIELD employee ON TABLE employee_credential TYPE record<user>;
      DEFINE FIELD secret ON TABLE employee_credential TYPE string;
      DEFINE FIELD created_at ON TABLE employee_credential TYPE datetime VALUE time::now();
      DEFINE FIELD rotated_at ON TABLE employee_credential TYPE option<datetime>;
      DEFINE INDEX employee_credential_employee_unique ON TABLE employee_credential COLUMNS employee UNIQUE;
      DEFINE TABLE workbook SCHEMAFULL PERMISSIONS FULL;
      DEFINE FIELD name ON TABLE workbook TYPE string;
      DEFINE TABLE ent_material SCHEMALESS PERMISSIONS FULL;
      DEFINE FUNCTION fn::current_user() { RETURN $auth.id; } PERMISSIONS FULL;
      DEFINE ACCESS employee_test ON DATABASE TYPE RECORD SIGNIN (
        SELECT * FROM user WHERE subject = $subject AND kind = "virtual"
          AND id = (SELECT VALUE employee FROM employee_credential WHERE secret = $pass LIMIT 1)[0]
      ) DURATION FOR SESSION 1h;
      DEFINE ACCESS human_test ON DATABASE TYPE RECORD SIGNIN (
        SELECT * FROM user WHERE email = $email AND crypto::argon2::compare(password, $password)
      ) DURATION FOR SESSION 1h;
      CREATE user:owner CONTENT {
        email: "owner@example.com", password: crypto::argon2::generate("owner-pass"),
        subject: "owner", kind: "human", is_admin: true
      };
      CREATE user:risk CONTENT {
        email: "risk@virtual.local", subject: "risk", kind: "virtual", is_admin: false
      };
      CREATE employee_credential:risk CONTENT { employee: user:risk, secret: "risk-pass" };
      CREATE workbook:claims CONTENT { name: "债权台账" };
      CREATE ent_material:m1 CONTENT { is_missing: true };
    `).collect();

    const migration = (await loadTemplateScripts()).find((item) => item.version === 19);
    if (!migration) throw new Error("missing OIP-18 migration");
    await root.query(migration.sql).collect();

    const employee = new Surreal();
    opened.push(employee);
    await employee.connect(url, { namespace, database });
    await employee.signin({
      namespace,
      database,
      access: "employee_test",
      variables: { subject: "risk", pass: "risk-pass" },
    });
    const content = {
      dedupe_key: "2026-07-17|workbook:claims|ent_material:m1|missing-material",
      to_user: new StringRecordId("user:owner"),
      workbook: new StringRecordId("workbook:claims"),
      related_record: new StringRecordId("ent_material:m1"),
      risk_type: "missing-material",
      title: "材料缺失",
      body: "材料记录被标记为缺失",
      severity: "warning",
      matched_fields: { is_missing: true },
      rule: "证据材料记录的“是否缺失”为是",
      checked_at: new Date("2026-07-17T01:00:00.000Z"),
    };
    await employee.query("INSERT INTO user_notification $content ON DUPLICATE KEY UPDATE dedupe_key = $input.dedupe_key", { content }).collect();
    await employee.query("INSERT INTO user_notification $content ON DUPLICATE KEY UPDATE dedupe_key = $input.dedupe_key", { content }).collect();

    const count = await root.query<[Array<{ count: number }>]>(
      "SELECT count() FROM user_notification GROUP ALL",
    ).collect();
    expect(count[0]?.[0]?.count).toBe(1);

    const owner = new Surreal();
    opened.push(owner);
    await owner.connect(url, { namespace, database });
    await owner.signin({
      namespace,
      database,
      access: "human_test",
      variables: { email: "owner@example.com", password: "owner-pass" },
    });
    const inbox = await owner.query<[Array<{ id: unknown }>]>("SELECT id FROM user_notification").collect();
    expect(inbox[0]).toHaveLength(1);
  });
});
