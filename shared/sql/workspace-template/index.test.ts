import { describe, expect, test } from "bun:test";
import { loadTemplateScripts, WORKSPACE_TEMPLATE_VERSION } from "@surreal-ck/shared/workspace-template";

describe("workspace template scripts", () => {
  test("loads workspace template scripts in version order from the shared template directory", async () => {
    const scripts = await loadTemplateScripts();

    expect(WORKSPACE_TEMPLATE_VERSION).toBe(8);
    expect(scripts.map((script) => script.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(scripts.map((script) => script.name)).toEqual([
      "001-access.surql",
      "002-tables-core.surql",
      "003-tables-office.surql",
      "004-workflow-run.surql",
      "005-mastra-runtime-storage.surql",
      "006-tables-grid.surql",
      "007-access-claim-rename.surql",
      "008-resource-library.surql",
    ]);
    expect(scripts[0]?.sql).toContain("DEFINE ACCESS OVERWRITE admin");
    expect(scripts[1]?.sql).toContain("DEFINE TABLE IF NOT EXISTS user");
    expect(scripts[2]?.sql).toContain("DEFINE TABLE IF NOT EXISTS employee_credential");
    expect(scripts[3]?.sql).toContain("DEFINE TABLE IF NOT EXISTS workflow_run");
    expect(scripts[4]?.sql).toContain("DEFINE TABLE IF NOT EXISTS memory_thread");
    expect(scripts[5]?.sql).toContain("DEFINE TABLE IF NOT EXISTS workbook");
    expect(scripts[7]?.sql).toContain("DEFINE TABLE IF NOT EXISTS resource_item");
  });

  test("grid 业务表归属 workspace database：无 workspace 字段，PERMISSIONS 只表达本 workspace 角色", async () => {
    const scripts = await loadTemplateScripts();
    const grid = scripts.find((script) => script.name === "006-tables-grid.surql");

    expect(grid).toBeDefined();
    const sql = grid!.sql;
    // workbook / sheet / dashboard_page 三张表都在
    expect(sql).toContain("DEFINE TABLE IF NOT EXISTS workbook");
    expect(sql).toContain("DEFINE TABLE IF NOT EXISTS sheet");
    expect(sql).toContain("DEFINE TABLE IF NOT EXISTS dashboard_page");
    // 隔离靠 db 边界：不带 workspace 字段，也不写跨 workspace 的嵌套子查询
    expect(sql).not.toMatch(/DEFINE FIELD IF NOT EXISTS workspace ON TABLE workbook/);
    expect(sql).not.toMatch(/<-has_workspace_member<-workspace/);
    // 同 workspace 任何登录用户可见
    expect(sql).toContain("FOR select WHERE $auth != NONE");
    // DDL 由 access 类型卡死，写操作交给管理员（builder/导入），普通成员不建表
    expect(sql).toMatch(/FOR create, update, delete WHERE \$auth\.is_admin = true/);
    // searchRecord 需要 sheet 的 table_name / column_defs
    expect(sql).toContain("DEFINE FIELD IF NOT EXISTS table_name ON TABLE sheet");
    // column_defs 用 OVERWRITE（c9a3972：旧库该字段类型不对，需要覆盖重定义才能写入 sheet）
    expect(sql).toMatch(/DEFINE FIELD OVERWRITE column_defs ON TABLE sheet/);
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

  test("resource 库表归属 workspace database：四张表齐全、无 workspace 字段、归因 DEFAULT $auth", async () => {
    const scripts = await loadTemplateScripts();
    const resource = scripts.find((script) => script.name === "008-resource-library.surql");

    expect(resource).toBeDefined();
    const sql = resource!.sql;
    // 四张资源表都在
    expect(sql).toContain("DEFINE TABLE IF NOT EXISTS resource_item");
    expect(sql).toContain("DEFINE TABLE IF NOT EXISTS resource_embedding");
    expect(sql).toContain("DEFINE TABLE IF NOT EXISTS workspace_embedding_profile");
    expect(sql).toContain("DEFINE TABLE IF NOT EXISTS research_session");
    // 隔离靠 db 边界：不带 workspace 字段，不写跨 workspace 嵌套，不残留 sync 时代结构
    expect(sql).not.toMatch(/DEFINE FIELD [\w ]+ workspace ON TABLE/);
    expect(sql).not.toContain("<-has_workspace_member<-workspace");
    expect(sql).not.toContain("app_user");
    expect(sql).not.toContain("local_resource_session_link");
    expect(sql).not.toContain("_origin_session_id");
    // 归因走当前会话身份（真人或虚拟员工）
    expect(sql).toContain("DEFINE FIELD IF NOT EXISTS created_by ON TABLE resource_item TYPE record<user> DEFAULT $auth");
    expect(sql).toContain("DEFINE FIELD IF NOT EXISTS created_by ON TABLE research_session TYPE record<user> DEFAULT $auth");
    // 共享库：成员可读写，删除仅管理员
    expect(sql).toMatch(/resource_item SCHEMAFULL[\s\S]*?FOR select WHERE \$auth != NONE/);
    expect(sql).toMatch(/resource_item SCHEMAFULL[\s\S]*?FOR delete WHERE \$auth\.is_admin = true/);
    // 检索过程私有：创建者或管理员可见
    expect(sql).toMatch(/research_session SCHEMAFULL[\s\S]*?FOR select WHERE created_by = \$auth OR \$auth\.is_admin = true/);
  });

  test("resource_embedding 保留 (resource, profile_key) 唯一索引与 status 枚举；profile 仅管理员可写", async () => {
    const scripts = await loadTemplateScripts();
    const sql = scripts.find((script) => script.name === "008-resource-library.surql")!.sql;

    // embedding 行按 (resource, profile_key) 唯一，写入走 ON DUPLICATE KEY UPDATE
    expect(sql).toMatch(/DEFINE INDEX IF NOT EXISTS \w+ ON TABLE resource_embedding COLUMNS resource, profile_key UNIQUE/);
    expect(sql).toContain("DEFINE FIELD IF NOT EXISTS resource ON TABLE resource_embedding TYPE record<resource_item>");
    // V1 无 enqueue/retry endpoint，但 disabled/失败状态语义保留
    expect(sql).toMatch(/status ON TABLE resource_embedding[\s\S]*?\["disabled", "pending", "indexed", "failed", "stale"\]/);
    expect(sql).toContain("DEFINE FIELD IF NOT EXISTS vector ON TABLE resource_embedding TYPE array<float>");
    // embedding profile：成员可读、仅管理员可写；维度必须为正
    expect(sql).toMatch(/workspace_embedding_profile SCHEMAFULL[\s\S]*?FOR create, update, delete WHERE \$auth\.is_admin = true/);
    expect(sql).toMatch(/dimensions ON TABLE workspace_embedding_profile TYPE int[\s\S]*?ASSERT \$value > 0/);
  });

  test("keeps JWT access placeholders by default and can render them for backend execution", async () => {
    const rawScripts = await loadTemplateScripts();
    const rawSql = rawScripts.map((script) => script.sql).join("\n");

    // 001 两处 + 007 两处（admin / participant 各一）
    expect(rawSql.match(/<__OIDC_JWKS_URL__>/g)?.length).toBe(4);
    expect(rawScripts[0]?.sql).toContain("DEFINE ACCESS employee");
    expect(rawScripts[0]?.sql).not.toContain("DEFINE ACCESS employee ON DATABASE TYPE RECORD\n  WITH JWT");

    const renderedScripts = await loadTemplateScripts({
      oidcJwksUrl: "https://issuer.example.test/jwks.json",
    });
    const renderedSql = renderedScripts.map((script) => script.sql).join("\n");

    expect(renderedSql).not.toContain("<__OIDC_JWKS_URL__>");
    expect(renderedSql.match(/https:\/\/issuer\.example\.test\/jwks\.json/g)?.length).toBe(4);
  });
});
