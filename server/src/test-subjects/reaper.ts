// 测试主体到期清理：到期 workspace 连库删除，到期 test_subject 摘除运营能力与残留索引。
// 平台内容（platform_content 库与该主体写过的内容记录）不删除。
// 幂等：重复执行对已删除的行是 no-op；单对象失败不影响其它并记录日志。

import type { Queryable } from "./store";

type Log = (event: string, fields: Record<string, unknown>) => void;

const defaultLog: Log = (event, fields) => console.info(`[test-subject-reaper] ${event}`, fields);

/**
 * workspace 行在 _system 中的全部关联表（字段名 = 该表中指向 workspace 的 record 字段；
 * 值用字段名，record<workspace> 与 option<record<workspace>> 统一按等值删除）。
 * 逐表核对过 shared/sql/system/*.surql 后维护；新增引用表时同步补充。
 */
const WORKSPACE_REFERENCES: ReadonlyArray<readonly [table: string, field: string]> = [
  ["user_workspace_index", "workspace"],
  ["quota_subscription_item", "workspace"],
  ["quota_override_revision", "workspace"],
  ["workspace_quota_override", "workspace"],
  ["resource_entitlement", "workspace"],
  ["quota_policy_projection", "workspace"],
  ["entitlement_operation", "workspace"],
  ["quota_materialization_operation", "workspace"],
  ["workspace_quota_runtime", "workspace"],
  ["quota_operator_intent", "workspace"],
  ["quota_audit_event", "workspace"],
  ["quota_alert_state", "workspace"],
  ["quota_notification_outbox", "workspace"],
  ["quota_lifecycle_intent", "workspaces"], // array<record<workspace>>，用 CONTAINS 单独处理
  ["quota_migration_assignment", "workspace"],
  ["quota_migration_inventory", "workspace"],
  ["quota_migration_signal", "workspace"],
  ["quota_migration_workspace_operation", "workspace"],
  ["quota_operator_intent_state", "workspace"],
  ["workspace_activation_summary", "workspace"],
  ["workspace_activation_summary_audit", "workspace"],
  ["content_grant", "workspace"],
  ["workspace_product_entitlement", "workspace"],
  ["product_entitlement_audit", "workspace"],
];

/** 以字符串字段（非 record）引用 db_name 的表。 */
const DB_NAME_REFERENCES: ReadonlyArray<readonly [table: string, field: string]> = [
  ["ops_invitation", "workspace_db"],
  ["funnel_event_count", "workspace_key"],
];

export interface TestSubjectReaperDeps {
  /** _system 库会话（root）。 */
  systemDb: Queryable;
  /** 删除一个 database 的客户端（root 平台维护身份）。 */
  dropDatabase: (dbName: string) => Promise<void>;
  now?: () => Date;
  log?: Log;
}

interface ExpiredWorkspaceRow {
  id: string;
  slug: string;
  db_name: string;
  owner_subject: string;
  test_origin: string | null;
}

function firstArray(result: unknown): Record<string, unknown>[] {
  if (!Array.isArray(result) || !Array.isArray(result[0])) return [];
  return result[0] as Record<string, unknown>[];
}

/**
 * 删除一个测试 workspace：安全栅栏 → REMOVE DATABASE → 清理 _system 引用行 → 删 workspace 行。
 * 若 workspace 存在任何「不在未到期 test_subject」的成员，跳过并告警。
 */
export async function purgeTestWorkspace(
  deps: TestSubjectReaperDeps,
  workspaceId: string,
): Promise<"purged" | "skipped"> {
  const log = deps.log ?? defaultLog;

  const members = firstArray(await deps.systemDb.query(
    `SELECT subject FROM user_workspace_index WHERE workspace = $wid;`,
    { wid: workspaceId },
  ));
  const testSubjects = new Set(
    firstArray(await deps.systemDb.query(
      `SELECT subject FROM test_subject;`,
    )).map((row) => String(row.subject)),
  );
  const foreignMembers = members
    .map((row) => String(row.subject))
    .filter((subject) => !testSubjects.has(subject));

  const [workspace] = firstArray(await deps.systemDb.query(
    `SELECT id, slug, db_name, owner_subject, test_origin FROM workspace WHERE id = $wid;`,
    { wid: workspaceId },
  )) as unknown as ExpiredWorkspaceRow[];
  if (workspace === undefined) return "purged";

  if (foreignMembers.length > 0) {
    log("workspace.skip_foreign_members", {
      slug: workspace.slug,
      db_name: workspace.db_name,
      foreignMemberCount: foreignMembers.length,
    });
    return "skipped";
  }

  await deps.dropDatabase(workspace.db_name);

  for (const [table, field] of WORKSPACE_REFERENCES) {
    if (table === "quota_lifecycle_intent") {
      await deps.systemDb.query(
        `DELETE ${table} WHERE workspace = $wid OR workspaces CONTAINS $wid;`,
        { wid: workspaceId },
      );
      continue;
    }
    await deps.systemDb.query(`DELETE ${table} WHERE ${field} = $wid;`, { wid: workspaceId });
  }
  for (const [table, field] of DB_NAME_REFERENCES) {
    await deps.systemDb.query(`DELETE ${table} WHERE ${field} = $dbName;`, { dbName: workspace.db_name });
  }
  await deps.systemDb.query(`DELETE workspace WHERE id = $wid;`, { wid: workspaceId });

  log("workspace.purged", {
    slug: workspace.slug,
    db_name: workspace.db_name,
    owner_subject: workspace.owner_subject,
    origin: workspace.test_origin,
  });
  return "purged";
}

/** 删除一个测试主体：摘除 platform_operator/能力行与残留成员索引，最后删 test_subject 行。 */
export async function purgeTestSubject(
  deps: TestSubjectReaperDeps,
  subject: string,
): Promise<void> {
  const log = deps.log ?? defaultLog;
  await deps.systemDb.query(
    `DELETE platform_operator_capability
     WHERE operator IN (SELECT VALUE id FROM platform_operator WHERE subject = $subject);`,
    { subject },
  );
  await deps.systemDb.query(`DELETE platform_operator WHERE subject = $subject;`, { subject });
  await deps.systemDb.query(`DELETE user_workspace_index WHERE subject = $subject;`, { subject });
  await deps.systemDb.query(`DELETE test_subject WHERE subject = $subject;`, { subject });
  log("subject.purged", { subject });
}

/** 一轮清理：到期 workspace → 到期 test_subject。返回处理统计。 */
export async function runTestSubjectReaper(
  deps: TestSubjectReaperDeps,
): Promise<{ workspacesPurged: number; workspacesSkipped: number; subjectsPurged: number }> {
  const log = deps.log ?? defaultLog;
  const now = deps.now?.() ?? new Date();
  const nowIso = now.toISOString();
  let workspacesPurged = 0;
  let workspacesSkipped = 0;
  let subjectsPurged = 0;

  const expiredWorkspaces = firstArray(await deps.systemDb.query(
    `SELECT id, slug, db_name, owner_subject, test_origin
     FROM workspace
     WHERE test_expires_at != NONE AND test_expires_at <= $now;`,
    { now: nowIso },
  )) as unknown as ExpiredWorkspaceRow[];

  for (const workspace of expiredWorkspaces) {
    try {
      const outcome = await purgeTestWorkspace(deps, workspace.id);
      if (outcome === "purged") workspacesPurged += 1;
      else workspacesSkipped += 1;
    } catch (error) {
      workspacesSkipped += 1;
      log("workspace.purge_failed", {
        slug: workspace.slug,
        db_name: workspace.db_name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const expiredSubjects = firstArray(await deps.systemDb.query(
    `SELECT subject FROM test_subject WHERE expires_at <= $now;`,
    { now: nowIso },
  ));

  for (const row of expiredSubjects) {
    try {
      await purgeTestSubject(deps, String(row.subject));
      subjectsPurged += 1;
    } catch (error) {
      log("subject.purge_failed", {
        subject: row.subject,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { workspacesPurged, workspacesSkipped, subjectsPurged };
}
