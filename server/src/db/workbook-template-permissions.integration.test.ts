import { afterEach, describe, expect, test } from "bun:test";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { loadTemplatePackScripts } from "@surreal-ck/shared/template-packs";
import { Surreal, Table } from "surrealdb";

const localSurrealTest = test.skipIf(process.env.RUN_LOCAL_SURREALDB_TESTS !== "1");
const opened: Surreal[] = [];

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((db) => db.close()));
});

describe("workbook_template SurrealDB access contract", () => {
  localSurrealTest("普通成员可读新旧模板，但无法写模板或执行结构创建", async () => {
    const url = process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
    const namespace = process.env.LOCAL_SURREAL_NS ?? "main";
    const database = `template_permissions_${Date.now().toString(36)}`;
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
      DEFINE FIELD password ON TABLE user TYPE string;
      DEFINE FIELD is_admin ON TABLE user TYPE bool DEFAULT false;
      DEFINE ACCESS participant ON DATABASE TYPE RECORD
        SIGNIN (
          SELECT * FROM user
          WHERE email = $email
            AND crypto::argon2::compare(password, $password)
        )
        DURATION FOR SESSION 1h;
      DEFINE TABLE workbook SCHEMAFULL PERMISSIONS FULL;
      CREATE user:member CONTENT {
        email: "member@example.com",
        password: crypto::argon2::generate("member-pass"),
        is_admin: false,
      };
    `).collect();

    const scripts = await loadTemplateScripts();
    for (const name of ["011-workbook-template.surql", "012-workbook-template-package.surql"]) {
      const script = scripts.find((candidate) => candidate.name === name);
      if (!script) throw new Error(`missing workspace migration: ${name}`);
      await root.query(script.sql).collect();
    }
    const [legalStarter] = await loadTemplatePackScripts({ selectedPacks: ["legal-starter"] });
    if (!legalStarter) throw new Error("missing template pack: legal-starter");
    await root.query(legalStarter.sql).collect();

    await root.insert(new Table("workbook_template"), {
      key: "claims",
      label: "破产债权管理",
      sheet_defs: [{
        key: "creditors",
        label: "债权人表",
        column_defs: [{
          key: "creditor_name",
          label: "债权人名称",
          field_type: "text",
          aliases: ["申报人", "债权人"],
        }],
      }],
    });

    const participant = new Surreal();
    opened.push(participant);
    await participant.connect(url, { namespace, database });
    await participant.signin({
      namespace,
      database,
      access: "participant",
      variables: { email: "member@example.com", password: "member-pass" },
    });

    const templates = await participant.select<Record<string, unknown>>(new Table("workbook_template"));
    expect(templates.map((template) => template.key).sort()).toEqual([
      "asset",
      "case",
      "claims",
      "compliance",
      "diligence",
      "entity",
    ]);
    expect(templates.find((template) => template.key === "claims")?.sheet_defs).toEqual([{
      key: "creditors",
      label: "债权人表",
      column_defs: [{
        key: "creditor_name",
        label: "债权人名称",
        field_type: "text",
        aliases: ["申报人", "债权人"],
      }],
    }]);

    const deniedWrite = await participant.insert(new Table("workbook_template"), {
      key: "forbidden",
      label: "越权模板",
    });
    expect(deniedWrite).toEqual([]);
    await expect(
      participant.query("DEFINE TABLE forbidden_structure SCHEMALESS").collect(),
    ).rejects.toThrow();
  }, 15_000);

  localSurrealTest("工作区管理员可在已有 workspace 幂等安装同一模板包", async () => {
    const url = process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
    const namespace = process.env.LOCAL_SURREAL_NS ?? "main";
    const database = `template_pack_admin_${Date.now().toString(36)}`;
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
      DEFINE FIELD password ON TABLE user TYPE string;
      DEFINE FIELD is_admin ON TABLE user TYPE bool DEFAULT false;
      DEFINE ACCESS template_pack_admin ON DATABASE TYPE RECORD
        SIGNIN (
          SELECT * FROM user
          WHERE email = $email
            AND is_admin = true
            AND crypto::argon2::compare(password, $password)
        )
        DURATION FOR SESSION 1h;
      DEFINE TABLE workbook SCHEMAFULL PERMISSIONS FULL;
      CREATE user:admin CONTENT {
        email: "admin@example.com",
        password: crypto::argon2::generate("admin-pass"),
        is_admin: true,
      };
    `).collect();

    const schema = (await loadTemplateScripts()).find(
      (script) => script.name === "011-workbook-template.surql",
    );
    if (!schema) throw new Error("missing workspace migration: 011-workbook-template.surql");
    await root.query(schema.sql).collect();

    const admin = new Surreal();
    opened.push(admin);
    await admin.connect(url, { namespace, database });
    await admin.signin({
      namespace,
      database,
      access: "template_pack_admin",
      variables: { email: "admin@example.com", password: "admin-pass" },
    });

    const [legalStarter] = await loadTemplatePackScripts({ selectedPacks: ["legal-starter"] });
    if (!legalStarter) throw new Error("missing template pack: legal-starter");
    await admin.query(legalStarter.sql).collect();
    await admin.query(`
      UPDATE workbook_template
      SET column_defs = [{ key: "administrator-added-field" }]
      WHERE key = "case";
    `).collect();
    await admin.query(legalStarter.sql).collect();

    const [templates] = await admin.query<[
      Array<{ key: string; column_defs: Array<{ key: string }> }>,
    ]>("SELECT key, column_defs FROM workbook_template ORDER BY key;").collect();
    expect(templates).toHaveLength(5);
    expect(templates.find((template) => template.key === "case")?.column_defs).toEqual([
      { key: "administrator-added-field" },
    ]);
  }, 15_000);
});
