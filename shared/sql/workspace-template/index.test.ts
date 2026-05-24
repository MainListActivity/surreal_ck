import { describe, expect, test } from "bun:test";
import { loadTemplateScripts, WORKSPACE_TEMPLATE_VERSION } from "@surreal-ck/shared/workspace-template";

describe("workspace template scripts", () => {
  test("loads workspace template scripts in version order from the shared template directory", async () => {
    const scripts = await loadTemplateScripts();

    expect(WORKSPACE_TEMPLATE_VERSION).toBe(5);
    expect(scripts.map((script) => script.version)).toEqual([1, 2, 3, 4, 5]);
    expect(scripts.map((script) => script.name)).toEqual([
      "001-access.surql",
      "002-tables-core.surql",
      "003-tables-office.surql",
      "004-workflow-run.surql",
      "005-mastra-runtime-storage.surql",
    ]);
    expect(scripts[0]?.sql).toContain("DEFINE ACCESS admin");
    expect(scripts[1]?.sql).toContain("DEFINE TABLE IF NOT EXISTS user");
    expect(scripts[2]?.sql).toContain("DEFINE TABLE IF NOT EXISTS employee_credential");
    expect(scripts[3]?.sql).toContain("DEFINE TABLE IF NOT EXISTS workflow_run");
    expect(scripts[4]?.sql).toContain("DEFINE TABLE IF NOT EXISTS memory_thread");
  });

  test("workflow_run 表归属 workspace database：无 workspace 字段，owner_user 默认归因到当前会话", async () => {
    const scripts = await loadTemplateScripts();
    const workflowRun = scripts.find((script) => script.name === "004-workflow-run.surql");

    expect(workflowRun).toBeDefined();
    const sql = workflowRun!.sql;
    // 归属由 workspace database 边界表达，不再带 workspace 字段
    expect(sql).not.toMatch(/DEFINE FIELD IF NOT EXISTS workspace ON TABLE workflow_run/);
    // owner_user 是 record<user>，默认取当前会话身份（真人 $auth 或虚拟员工 $auth）
    expect(sql).toContain("DEFINE FIELD IF NOT EXISTS owner_user ON TABLE workflow_run TYPE record<user>");
    expect(sql).toContain("DEFAULT $auth");
    // 至少覆盖 owner_user + status 的索引，便于恢复未完成 run
    expect(sql).toMatch(/DEFINE INDEX IF NOT EXISTS \w+ ON TABLE workflow_run COLUMNS owner_user, status/);
    // 普通成员只能看自己的 run，管理员可审计本 workspace 内 run
    expect(sql).toContain("FOR select WHERE owner_user = $auth OR $auth.is_admin = true");
  });

  test("Mastra runtime storage schema covers workflow statuses, memory, and observability tables", async () => {
    const scripts = await loadTemplateScripts();
    const mastraStorage = scripts.find((script) => script.name === "005-mastra-runtime-storage.surql");

    expect(mastraStorage).toBeDefined();
    const sql = mastraStorage!.sql;
    expect(sql).toContain("DEFINE FIELD OVERWRITE status ON TABLE workflow_run");
    expect(sql).toContain('"pending"');
    expect(sql).toContain('"success"');
    expect(sql).toContain('"canceled"');
    expect(sql).toContain("DEFINE TABLE IF NOT EXISTS memory_resource");
    expect(sql).toContain("DEFINE TABLE IF NOT EXISTS memory_thread");
    expect(sql).toContain("DEFINE TABLE IF NOT EXISTS memory_message");
    expect(sql).toContain("DEFINE TABLE IF NOT EXISTS observability_span");
    expect(sql).toContain("DEFINE TABLE IF NOT EXISTS observability_event_raw");
    expect(sql).toMatch(/DEFINE FIELD IF NOT EXISTS owner_user ON TABLE memory_thread TYPE record<user> DEFAULT \$auth/);
    expect(sql).toMatch(/FOR select WHERE owner_user = \$auth OR \$auth\.is_admin = true/);
  });

  test("keeps JWT access placeholders by default and can render them for backend execution", async () => {
    const rawScripts = await loadTemplateScripts();
    const rawSql = rawScripts.map((script) => script.sql).join("\n");

    expect(rawSql.match(/<__OIDC_JWKS_URL__>/g)?.length).toBe(2);
    expect(rawScripts[0]?.sql).toContain("DEFINE ACCESS employee");
    expect(rawScripts[0]?.sql).not.toContain("DEFINE ACCESS employee ON DATABASE TYPE RECORD\n  WITH JWT");

    const renderedScripts = await loadTemplateScripts({
      oidcJwksUrl: "https://issuer.example.test/jwks.json",
    });
    const renderedSql = renderedScripts.map((script) => script.sql).join("\n");

    expect(renderedSql).not.toContain("<__OIDC_JWKS_URL__>");
    expect(renderedSql.match(/https:\/\/issuer\.example\.test\/jwks\.json/g)?.length).toBe(2);
  });
});
