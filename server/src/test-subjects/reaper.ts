// 测试主体到期清理：到期 workspace 连库删除，到期 test_subject 摘除运营能力与残留索引。
// 平台内容（platform_content 库与该主体写过的内容记录）不删除。
// 幂等：重复执行对已删除的行是 no-op；单对象失败不影响其它并记录日志。

import { DateTime, StringRecordId } from "surrealdb";
import type { Queryable } from "./store";
import { retryAtomicConflict } from "../db/atomic-conflict-retry";
import { isTestKitProvisionRunning, TEST_KIT_STALE_MS } from "../invitations/invite-service";

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

/** 以字符串字段（非 record）引用 db_name 的表。
 * funnel_event_count.workspace_key 是 HMAC(db_name) 不是 db_name，等值删除永远
 * 命不中且聚合计数无需随库删除，不在此列。
 * ops_invitation 开通行不在此列：它是清理的审计凭证（test_kit_purged_at
 * 标记、重复 purge 的 alreadyPurged 判定、list/status 的 purged 展示都依赖它）。
 */
const DB_NAME_REFERENCES: ReadonlyArray<readonly [table: string, field: string]> = [];

export interface TestSubjectReaperDeps {
  /** _system 库会话（root）。 */
  systemDb: Queryable;
  /** 供外成员栅栏使用；缺省时现查 test_subject 全量。 */
  testSubjects?: string[];
  /** 删除一个 database 的客户端（root 平台维护身份）。 */
  dropDatabase: (dbName: string) => Promise<void>;
  cancelIdpProvision?: (cancellationToken: string) => Promise<void>;
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
 * 引用表可能从未被定义（如 quota_lifecycle_intent 没有任何 schema 定义）；
 * 该 fork 对不存在的表执行 DELETE 会报错，而 REMOVE DATABASE 已先执行，
 * 报错会让 workspace 行永远悬挂。表不存在即无可删行，只吞这一种错误。
 */
async function deleteIfTableExists(
  db: Queryable,
  table: string,
  sql: string,
  params: Record<string, unknown>,
): Promise<void> {
  try {
    await db.query(sql, params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(`'${table}'`) && message.includes("does not exist")) return;
    throw error;
  }
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

  const wid = new StringRecordId(workspaceId);
  const members = firstArray(await deps.systemDb.query(
    `SELECT subject, email FROM user_workspace_index WHERE workspace = $wid;`,
    { wid },
  ));
  const testRows = firstArray(await deps.systemDb.query(
    `SELECT subject, email, origin FROM test_subject;`,
  ));
  const testSubjects = new Set(testRows.map((row) => String(row.subject)));
  // 只信任测试物料自助开出的账号邮箱（来自 IdP）；运营登记时手填的邮箱不参与 NONE 行判定。
  const testEmails = new Set(testRows
    .filter((row) => typeof row.origin === "string" && row.origin.startsWith("test-kit:"))
    .map((row) => typeof row.email === "string" ? row.email.toLowerCase() : "")
    .filter((email) => email.length > 0));
  // 预加入未登录的成员索引 subject 为 NONE：其邮箱属于测试物料账号时同样视为测试成员。
  const foreignMembers = members
    .filter((row) => typeof row.subject === "string"
      ? !testSubjects.has(row.subject)
      : !(typeof row.email === "string" && testEmails.has(row.email.toLowerCase())))
    .map((row) => String(row.subject ?? row.email ?? ""));

  const [workspace] = firstArray(await deps.systemDb.query(
    `SELECT id, slug, db_name, owner_subject, test_origin FROM workspace WHERE id = $wid;`,
    { wid },
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

  // 未标记的领养库（如开通后才自建的 workspace）补打测试标记，
  // 让 050 迁移放宽的不可变控制面行可以随本次拆除一起 DELETE。
  await deps.systemDb.query(
    `UPDATE $wid SET
      test_origin = IF test_origin = NONE THEN "test-teardown" ELSE test_origin END,
      test_expires_at = IF test_expires_at = NONE THEN time::now() ELSE test_expires_at END;`,
    { wid },
  );

  await deps.dropDatabase(workspace.db_name);

  for (const [table, field] of WORKSPACE_REFERENCES) {
    if (table === "quota_lifecycle_intent") {
      await deleteIfTableExists(
        deps.systemDb,
        table,
        `DELETE ${table} WHERE workspace = $wid OR workspaces CONTAINS $wid;`,
        { wid },
      );
      continue;
    }
    await deleteIfTableExists(deps.systemDb, table, `DELETE ${table} WHERE ${field} = $wid;`, { wid });
  }
  for (const [table, field] of DB_NAME_REFERENCES) {
    await deleteIfTableExists(deps.systemDb, table, `DELETE ${table} WHERE ${field} = $dbName;`, { dbName: workspace.db_name });
  }
  await deps.systemDb.query(`DELETE workspace WHERE id = $wid;`, { wid });

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
  // 测试物料自助开出的账号：它自己拥有的 workspace 一并清理（含收养后后台执行迟到建出、
  // 从未被标记到期的库）。有外部成员的照常跳过。
  const kitOrigin = firstArray(await deps.systemDb.query(
    `SELECT VALUE origin FROM test_subject WHERE subject = $subject LIMIT 1;`,
    { subject },
  ))[0] as unknown;
  if (typeof kitOrigin === "string" && kitOrigin.startsWith("test-kit:")) {
    const owned = firstArray(await deps.systemDb.query(
      `SELECT VALUE id FROM workspace WHERE owner_subject = $subject;`,
      { subject },
    )) as unknown[];
    for (const ref of owned) await purgeTestWorkspace(deps, String(ref));
  }
  await deps.systemDb.query(
    `DELETE platform_operator_capability
     WHERE operator IN (SELECT VALUE id FROM platform_operator WHERE subject = $subject);`,
    { subject },
  );
  await deps.systemDb.query(`DELETE platform_operator WHERE subject = $subject;`, { subject });
  await deps.systemDb.query(`DELETE user_workspace_index WHERE subject = $subject;`, { subject });
  // 测试物料自助开出的账号（邮箱来自 IdP）：摘除它在测试 workspace 里预加入但从未登录的成员索引
  // （subject = NONE），并给它的开通行打清理标记，之后的对账不会把它重新登记回来。
  const own = firstArray(await deps.systemDb.query(
    `SELECT email, origin FROM test_subject WHERE subject = $subject LIMIT 1;`,
    { subject },
  ))[0];
  if (own && typeof own.origin === "string" && own.origin.startsWith("test-kit:")
    && typeof own.email === "string" && own.email.length > 0) {
    const email = own.email.toLowerCase();
    await deps.systemDb.query(
      `DELETE user_workspace_index WHERE subject = NONE AND email != NONE AND string::lowercase(email) = $email AND workspace.test_expires_at != NONE;`,
      { email },
    );
  }

  // 计费残留：测试 workspace 走 manual 来源会留下
  // billing_account(account_key=personal:<subject>) + member + quota_subscription(+item)。
  // 若该 billing_account 有非测试主体成员则跳过并告警（共享账户不可删）。
  const testSubjects = new Set(deps.testSubjects ?? firstArray(await deps.systemDb.query(
    `SELECT subject FROM test_subject;`,
  )).map((row) => String(row.subject ?? "")).filter((v) => v.length > 0));
  const billingRows = firstArray(await deps.systemDb.query(
    `SELECT id FROM billing_account WHERE account_key = $key;`,
    { key: `personal:${subject}` },
  ));
  for (const billingRow of billingRows) {
    const billingId = String(billingRow.id);
    const memberRows = firstArray(await deps.systemDb.query(
      `SELECT subject FROM billing_account_member WHERE billing_account = $bid;`,
      { bid: new StringRecordId(billingId) },
    ));
    const memberSubjects = memberRows
      .map((row) => String(row.subject ?? ""))
      .filter((s) => s.length > 0);
    const foreign = memberSubjects.filter((s) => s !== subject && !testSubjects.has(s));
    if (foreign.length > 0) {
      log("billing.skip_foreign_member", { billing_account: billingId, foreign });
      continue;
    }
    await deps.systemDb.query(
      `DELETE quota_subscription_item
       WHERE subscription IN (SELECT VALUE id FROM quota_subscription WHERE billing_account = $bid);`,
      { bid: new StringRecordId(billingId) },
    );
    await deps.systemDb.query(
      `DELETE quota_subscription WHERE billing_account = $bid;`,
      { bid: new StringRecordId(billingId) },
    );
    await deps.systemDb.query(
      `DELETE billing_account_member WHERE billing_account = $bid;`,
      { bid: new StringRecordId(billingId) },
    );
    await deps.systemDb.query(`DELETE billing_account WHERE id = $bid;`, { bid: new StringRecordId(billingId) });
    log("billing.purged", { billing_account: billingId, subject });
  }

  if (own && typeof own.origin === "string" && own.origin.startsWith("test-kit:")
    && typeof own.email === "string" && own.email.length > 0) {
    await deps.systemDb.query(
      `UPDATE ops_invitation SET test_kit_purged_at = time::now()
       WHERE string::starts_with(idempotency_key, "test-kit:") AND email = $email
         AND (test_kit_managed = NONE OR test_kit_managed = false OR status = "completed") AND test_kit_purged_at = NONE;`,
      { email: own.email.toLowerCase() },
    );
  }
  await deps.systemDb.query(`DELETE test_subject WHERE subject = $subject;`, { subject });
  log("subject.purged", { subject });
}

/** 失败行本身是持久清理队列，不依赖调用方再次轮询。 */
export async function purgeFailedTestKitInvitation(deps: TestSubjectReaperDeps, key: string): Promise<boolean> {
  const db: Queryable = { query: (sql, params) => retryAtomicConflict(() => deps.systemDb.query(sql, params)) };
  const [row] = firstArray(await db.query(
    `SELECT id, operator_subject, email, idp_user_id, workspace_slug, test_kit_purged_at, test_kit_cancellation_token
     FROM ops_invitation WHERE idempotency_key = $key AND test_kit_managed = true AND status = "failed" LIMIT 1;`,
    { key },
  ));
  if (!row) return false;
  if (row.test_kit_purged_at) return true;
  if (!deps.cancelIdpProvision || typeof row.test_kit_cancellation_token !== "string") return false;
  if (typeof row.idp_user_id === "string") {
    const subject = row.idp_user_id;
    const origin = `test-kit:${String(row.operator_subject)}`;
    const workspaces = firstArray(await db.query(
      `SELECT id, slug FROM workspace WHERE owner_subject = $subject;`,
      { subject },
    ));
    if (workspaces.some((workspace) => workspace.slug !== row.workspace_slug)) return false;

    // 只使用本行持久化的 IdP id；不按邮箱认领，不能覆盖已有主体归属。
    await db.query(
      `INSERT INTO test_subject { subject: $subject, email: $email, origin: $origin, expires_at: time::now() }
       ON DUPLICATE KEY UPDATE updated_at = time::now();`,
      { subject, email: row.email, origin },
    );
    const [registered] = firstArray(await db.query(
      `SELECT origin, email FROM test_subject WHERE subject = $subject LIMIT 1;`,
      { subject },
    ));
    if (registered?.origin !== origin || registered.email !== row.email) return false;
    const cleanupDeps = {
      ...deps,
      systemDb: db,
      dropDatabase: (name: string) => retryAtomicConflict(() => deps.dropDatabase(name)),
    };
    for (const workspace of workspaces) {
      if (await purgeTestWorkspace(cleanupDeps, String(workspace.id)) !== "purged") return false;
    }
    await purgeTestSubject(cleanupDeps, subject);
  }
  // 撤销凭证在调用 IdP 前已落库，响应丢失时同样能精确撤销，不按邮箱找人。
  await deps.cancelIdpProvision(row.test_kit_cancellation_token);
  await db.query(
    `UPDATE $id SET test_kit_purged_at = time::now(), test_kit_cancellation_token = NONE
     WHERE test_kit_purged_at = NONE;`,
    { id: new StringRecordId(String(row.id)) },
  );
  return true;
}

export async function runFailedTestKitInvitationReaper(deps: TestSubjectReaperDeps): Promise<void> {
  const log = deps.log ?? defaultLog;
  const stale = new DateTime(new Date((deps.now?.() ?? new Date()).getTime() - TEST_KIT_STALE_MS));
  const query: Queryable["query"] = (sql, params) => retryAtomicConflict(() => deps.systemDb.query(sql, params));
  const pending = firstArray(await query(
    `SELECT id, idempotency_key, status FROM ops_invitation
     WHERE test_kit_managed = true AND test_kit_purged_at = NONE
       AND (status = "failed" OR (status = "processing" AND processing_since < $stale));`,
    { stale },
  ));
  for (const row of pending) {
    try {
      const key = String(row.idempotency_key);
      if (row.status === "processing") {
        // 开通与清理共用单个 origin 进程；不能清理仍在执行的慢请求。
        if (isTestKitProvisionRunning(key)) continue;
        const updated = firstArray(await query(
          `UPDATE $id SET status = "failed", completed_at = time::now(),
            error_code = "invite-interrupted", activation_url = NONE
           WHERE status = "processing" AND processing_since < $stale;`,
          { id: new StringRecordId(String(row.id)), stale },
        ));
        if (!updated.length) continue;
      }
      if (!await purgeFailedTestKitInvitation(deps, key)) {
        log("test_kit.cleanup_deferred", {});
      }
    } catch {
      log("test_kit.cleanup_failed", {});
    }
  }
}

/** 一轮清理：到期 workspace → 到期 test_subject。返回处理统计。 */
export async function runTestSubjectReaper(
  deps: TestSubjectReaperDeps,
): Promise<{ workspacesPurged: number; workspacesSkipped: number; subjectsPurged: number }> {
  const log = deps.log ?? defaultLog;
  const now = deps.now?.() ?? new Date();
  const nowParam = new DateTime(now);
  let workspacesPurged = 0;
  let workspacesSkipped = 0;
  let subjectsPurged = 0;
  const expiredWorkspaces = firstArray(await deps.systemDb.query(
    `SELECT id, slug, db_name, owner_subject, test_origin
     FROM workspace
     WHERE test_expires_at != NONE AND test_expires_at <= $now;`,
    { now: nowParam },
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
    `SELECT subject FROM test_subject WHERE expires_at <= $now
     AND subject NOT IN (SELECT VALUE idp_user_id FROM ops_invitation
       WHERE test_kit_managed = true AND status != "completed" AND test_kit_purged_at = NONE AND idp_user_id != NONE);`,
    { now: nowParam },
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
