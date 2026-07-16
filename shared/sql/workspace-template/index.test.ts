import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTemplateScripts, WORKSPACE_TEMPLATE_VERSION } from "@surreal-ck/shared/workspace-template";

const temporaryMigrationDirectories: string[] = [];

async function createMigrationDirectory(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "surreal-ck-workspace-template-"));
  temporaryMigrationDirectories.push(directory);

  await Promise.all(Object.entries(files).map(([name, sql]) => writeFile(join(directory, name), sql, "utf8")));
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryMigrationDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("workspace template scripts", () => {
  test("自动发现合法编号的 SurQL 增量并严格按版本加载", async () => {
    const migrationsDir = await createMigrationDirectory({
      "002-second.surql": "-- second fixture",
      "001-first.surql": "-- first fixture",
    });

    const scripts = await loadTemplateScripts({ migrationsDir });

    expect(scripts).toEqual([
      { version: 1, name: "001-first.surql", sql: "-- first fixture" },
      { version: 2, name: "002-second.surql", sql: "-- second fixture" },
    ]);
  });

  test("重复迁移版本会在加载任何脚本前给出明确错误", async () => {
    const migrationsDir = await createMigrationDirectory({
      "001-first.surql": "-- first fixture",
      "001-duplicate.surql": "-- duplicate fixture",
    });

    await expect(loadTemplateScripts({ migrationsDir })).rejects.toThrow(
      "workspace template migration version 001 is duplicated",
    );
  });

  test("迁移版本断档会在加载任何脚本前指出缺失版本", async () => {
    const migrationsDir = await createMigrationDirectory({
      "001-first.surql": "-- first fixture",
      "003-third.surql": "-- third fixture",
    });

    await expect(loadTemplateScripts({ migrationsDir })).rejects.toThrow(
      "workspace template migration version 002 is missing",
    );
  });

  test("非法 SurQL 文件名会在加载任何脚本前给出明确错误", async () => {
    const migrationsDir = await createMigrationDirectory({
      "001-first.surql": "-- first fixture",
      "2-invalid.surql": "-- invalid fixture",
    });

    await expect(loadTemplateScripts({ migrationsDir })).rejects.toThrow(
      "invalid workspace template migration filename: 2-invalid.surql",
    );
  });

  test("模板包 schema 增量保留旧 column_defs，并新增可容纳稳定表 key、名称、字段与列别名的 sheet_defs", async () => {
    const scripts = await loadTemplateScripts();
    const migration = scripts.find((script) => script.name === "012-workbook-template-package.surql");

    expect(migration).toBeDefined();
    expect(migration?.sql).toMatch(
      /DEFINE FIELD IF NOT EXISTS sheet_defs ON TABLE workbook_template TYPE array<object>\s+DEFAULT \[\]/,
    );
    expect(migration?.sql).not.toMatch(/REMOVE FIELD\s+column_defs/i);
  });

  test("跨数据表引用增量为模板字段声明受约束的目标数据表 key", async () => {
    const scripts = await loadTemplateScripts();
    const migration = scripts.find((script) => script.name === "013-template-cross-sheet-reference.surql");

    expect(migration).toBeDefined();
    expect(migration?.sql).toMatch(
      /DEFINE FIELD IF NOT EXISTS sheet_defs\.\*\.column_defs\.\*\.reference_sheet_key ON TABLE workbook_template TYPE option<string>/,
    );
    expect(migration?.sql).toContain("string::len($value) <= 64");
  });

  test("模板样例数据增量约束稳定记录 key，并允许每条记录携带字段值", async () => {
    const scripts = await loadTemplateScripts();
    const migration = scripts.find((script) => script.name === "014-template-sample-data.surql");

    expect(migration).toBeDefined();
    expect(migration?.sql).toMatch(
      /DEFINE FIELD IF NOT EXISTS sheet_defs\.\*\.sample_records ON TABLE workbook_template TYPE option<array<object>>/,
    );
    expect(migration?.sql).toContain("sheet_defs.*.sample_records.*.key");
    expect(migration?.sql).toContain("sheet_defs.*.sample_records.*.values");
  });

  test("默认仪表盘增量把结构化页面声明加入 workbook_template", async () => {
    const scripts = await loadTemplateScripts();
    const migration = scripts.find((script) => script.name === "015-template-default-dashboard.surql");

    expect(migration?.version).toBe(15);
    expect(migration?.sql).toContain("default_dashboard");
    expect(migration?.sql).toContain("default_dashboard.widgets");
  });

  test("模板快捷任务增量保存任务声明，并让实例化数据表保留稳定模板 key", async () => {
    const scripts = await loadTemplateScripts();
    const migration = scripts.find((script) => script.name === "016-template-quick-tasks.surql");

    expect(migration?.version).toBe(16);
    expect(migration?.sql).toContain("quick_tasks");
    expect(migration?.sql).toContain("quick_tasks.*.task_text");
    expect(migration?.sql).toContain("quick_tasks.*.sheet_keys");
    expect(migration?.sql).toContain("quick_tasks.*.risk");
    expect(migration?.sql).toContain("template_sheet_key ON TABLE sheet");
  });

  test("默认目录的迁移版本由实际最高脚本推导，无需维护 TypeScript 清单", async () => {
    const scripts = await loadTemplateScripts();

    expect(scripts.map((script) => script.version)).toEqual(
      Array.from({ length: scripts.length }, (_, index) => index + 1),
    );
    expect(scripts.every((script) => script.name.startsWith(String(script.version).padStart(3, "0") + "-"))).toBe(
      true,
    );
    expect(WORKSPACE_TEMPLATE_VERSION).toBe(scripts.at(-1)?.version);
  });

  test("通用 workspace schema 不包含垂直模板数据播种", async () => {
    const scripts = await loadTemplateScripts();

    expect(scripts.some((script) => script.sql.includes("INSERT INTO workbook_template"))).toBe(false);
  });

  test("OIP-18 风险提醒 schema 以每日运行和提醒唯一索引保证幂等，并仅允许 employee 创建", async () => {
    const scripts = await loadTemplateScripts();
    const migration = scripts.find((script) => script.name === "019-daily-claims-risk-reminder.surql");

    expect(migration?.version).toBe(19);
    const sql = migration?.sql ?? "";
    expect(sql).toContain("risk_reminders_enabled ON TABLE workbook TYPE bool DEFAULT false");
    expect(sql).toMatch(/DEFINE TABLE IF NOT EXISTS risk_check_run SCHEMAFULL/);
    expect(sql).toMatch(/DEFINE INDEX IF NOT EXISTS \w+ ON TABLE risk_check_run COLUMNS check_date UNIQUE/);
    expect(sql).toMatch(/DEFINE TABLE IF NOT EXISTS user_notification SCHEMAFULL CHANGEFEED 7d/);
    expect(sql).toMatch(/FOR create WHERE \$auth\.kind = "virtual"/);
    expect(sql).toMatch(/DEFINE INDEX IF NOT EXISTS \w+ ON TABLE user_notification COLUMNS dedupe_key UNIQUE/);
    expect(sql).toContain("matched_fields ON TABLE user_notification TYPE object FLEXIBLE");
    expect(sql).toContain("rule ON TABLE user_notification TYPE string");
    expect(sql).toContain("checked_at ON TABLE user_notification TYPE datetime");
  });

  test("workbook_template：类型由业务数据定义——底层不枚举行业类型，仅管理员可增改删，workbook 引用为可选 record", async () => {
    const scripts = await loadTemplateScripts();
    const tpl = scripts.find((script) => script.name === "011-workbook-template.surql");

    expect(tpl).toBeDefined();
    const sql = tpl!.sql;

    expect(sql).toContain("DEFINE TABLE IF NOT EXISTS workbook_template");
    // key 唯一索引：稳定业务标识 + 独立模板包幂等 seed 的依据
    expect(sql).toContain("DEFINE INDEX IF NOT EXISTS workbook_template_key_unique ON TABLE workbook_template COLUMNS key UNIQUE");
    // 展示元数据是数据字段，不是底层枚举：icon / accent 都在表里
    expect(sql).toContain("DEFINE FIELD IF NOT EXISTS icon ON TABLE workbook_template");
    expect(sql).toContain("DEFINE FIELD IF NOT EXISTS accent ON TABLE workbook_template");
    // 跨 workspace 隔离靠 db 边界：模板表不带 workspace 字段
    expect(sql).not.toMatch(/DEFINE FIELD IF NOT EXISTS workspace ON TABLE workbook_template/);
    // 模板全员可见，仅管理员可增改删
    expect(sql).toContain("FOR select WHERE $auth != NONE");
    expect(sql).toContain("FOR create, update, delete WHERE $auth.is_admin = true");
    // workbook 升级为 option record 引用——空=空白工作簿；底层不枚举类型字符串
    expect(sql).toContain("DEFINE FIELD OVERWRITE template ON TABLE workbook TYPE option<record<workbook_template>>");
    expect(sql).not.toContain("INSERT INTO workbook_template");
  });

  test("fn::current_user：JWT 会话($auth NONE)按 $token.sub 反查，RECORD 会话直接返回 $auth，函数对所有会话可调用", async () => {
    const scripts = await loadTemplateScripts();
    const fn = scripts.find((script) => script.name === "009-fn-current-user.surql");

    expect(fn).toBeDefined();
    const sql = fn!.sql;

    expect(sql).toContain("DEFINE FUNCTION OVERWRITE fn::current_user() -> option<record<user>>");
    // RECORD 路径：$auth 已是 user，直接取 id
    expect(sql).toMatch(/IF \$auth != NONE[\s\S]*?RETURN \$auth\.id/);
    // JWT 路径：按 $token.sub 反查 user.subject
    expect(sql).toMatch(/SELECT VALUE id FROM ONLY user WHERE subject = \$token\.sub/);
    // 函数需对所有会话可调用（admin/participant/employee 都要能拿当前用户）
    expect(sql).toContain("PERMISSIONS FULL");
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
    // owner_user 是 record<user>，默认取当前会话身份。归因走 fn::current_user()：
    // admin(JWT) 会话 $auth 为 NONE，靠 $token.sub 反查；participant/employee(RECORD) 直接返回 $auth。
    expect(sql).toContain("DEFINE FIELD IF NOT EXISTS owner_user ON TABLE workflow_run TYPE record<user>");
    expect(sql).toContain("DEFAULT fn::current_user()");
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

  test("activity_event 表归属 workspace database：归因 fn::current_user()、verb 枚举、静态表挂 event", async () => {
    const scripts = await loadTemplateScripts();
    const activity = scripts.find((script) => script.name === "010-activity-event.surql");

    expect(activity).toBeDefined();
    const sql = activity!.sql;

    expect(sql).toContain("DEFINE TABLE IF NOT EXISTS activity_event");
    // 隔离靠 db 边界：不带 workspace 字段
    expect(sql).not.toMatch(/DEFINE FIELD [\w ]+ workspace ON TABLE activity_event/);
    // 归因走当前会话身份（009），与 admin/participant/employee 三路兼容
    expect(sql).toContain("DEFINE FIELD IF NOT EXISTS actor ON TABLE activity_event TYPE option<record<user>> DEFAULT fn::current_user()");
    // verb 用枚举约束，覆盖 workbook / field / record 写入动词
    expect(sql).toMatch(/verb ON TABLE activity_event TYPE string\s+ASSERT \$value INSIDE \[/);
    expect(sql).toContain('"workbook.create"');
    expect(sql).toContain('"record.write"');
    // 同 workspace 任何登录用户可读可写动态，仅管理员可改删
    expect(sql).toContain("FOR select WHERE $auth != NONE");
    expect(sql).toContain("FOR create WHERE $auth != NONE");
    expect(sql).toMatch(/FOR update, delete WHERE \$auth\.is_admin = true/);
    // created_at 带索引供列表倒序 / 趋势聚合
    expect(sql).toMatch(/DEFINE INDEX IF NOT EXISTS \w+ ON TABLE activity_event COLUMNS created_at/);
    // 静态业务表写入即落动态
    expect(sql).toContain("DEFINE EVENT OVERWRITE workbook_activity ON TABLE workbook");
    expect(sql).toContain("DEFINE EVENT OVERWRITE sheet_activity ON TABLE sheet");
    expect(sql).toContain("DEFINE EVENT OVERWRITE dashboard_page_activity ON TABLE dashboard_page");
    expect(sql).toContain("CREATE activity_event CONTENT");
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
