// 测试主体登记前的只读预检：PUT 会把「该 subject 为唯一成员」的既有 workspace
// 回填 test_expires_at（到期后整库删除），到期清理还会删除该 subject 的全部
// user_workspace_index 行与 personal:<subject> 计费账户。预检把这些后果逐项列出，
// 并给出硬拒绝原因（正式运营主体、共享工作区的 owner/admin）。只读，不写任何行。

import { RecordId, StringRecordId } from "surrealdb";
import type { Queryable } from "./store";
import { findTestSubject } from "./store";
import { dateTimeTimestamp, toStringRecordId } from "../db/surreal-values";

export type TestSubjectPreflightBlocker = Readonly<{
  code: "active-platform-operator" | "shared-workspace-admin";
  message: string;
  workspace?: string;
}>;

export type TestSubjectPreflightWorkspace = Readonly<{
  id: string;
  slug: string | null;
  name: string | null;
  dbName: string | null;
  role: string | null;
  isOwner: boolean;
  memberCount: number;
  testExpiresAt: string | null;
  /** PUT 会给它写 test_expires_at（唯一成员即该 subject）。 */
  wouldBeMarked: boolean;
  /** 尚未被标记、本次登记才会第一次排入到期删除。 */
  newlyMarked: boolean;
  /** 共享工作区：到期清理会删除该 subject 在此的成员索引（工作区本身保留）。 */
  membershipRemovedOnExpiry: boolean;
}>;

export type TestSubjectPreflight = Readonly<{
  subject: string;
  testSubject: Readonly<{ email: string | null; expiresAt: string | null; origin: string | null }> | null;
  platformOperator: Readonly<{ status: string | null; kind: string | null }> | null;
  workspaces: readonly TestSubjectPreflightWorkspace[];
  personalBillingAccount: Readonly<{ exists: boolean; subscriptionCount: number }>;
  blockers: readonly TestSubjectPreflightBlocker[];
  warnings: readonly string[];
  /** 有 warnings 时必须原样回传 confirmationPhrase 才允许登记。 */
  requiresConfirmation: boolean;
  confirmationPhrase: string;
}>;

function rows(result: unknown): Record<string, unknown>[] {
  if (!Array.isArray(result) || !Array.isArray(result[0])) return [];
  return result[0] as Record<string, unknown>[];
}

function recordKey(value: unknown): string | null {
  if (value instanceof RecordId) return value.toString();
  if (value instanceof StringRecordId) return value.toString();
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isoOrNull(value: unknown): string | null {
  const ms = dateTimeTimestamp(value);
  return ms > 0 ? new Date(ms).toISOString() : null;
}

export function confirmationPhraseFor(subject: string): string {
  return `确认到期清理 ${subject}`;
}

export async function computeTestSubjectPreflight(
  db: Queryable,
  subject: string,
): Promise<TestSubjectPreflight> {
  const existing = await findTestSubject(db, subject);
  const operatorRow = rows(await db.query(
    `SELECT status, kind FROM platform_operator WHERE subject = $subject LIMIT 1;`,
    { subject },
  ))[0];
  const platformOperator = operatorRow === undefined
    ? null
    : { status: optionalString(operatorRow.status), kind: optionalString(operatorRow.kind) };

  const memberships = rows(await db.query(
    `SELECT workspace, role FROM user_workspace_index WHERE subject = $subject;`,
    { subject },
  ));
  const owned = rows(await db.query(
    `SELECT VALUE id FROM workspace WHERE owner_subject = $subject;`,
    { subject },
  ));

  const roleByWorkspace = new Map<string, string | null>();
  const refs = new Map<string, StringRecordId>();
  for (const membership of memberships) {
    const key = recordKey(membership.workspace);
    const ref = toStringRecordId(membership.workspace);
    if (key === null || ref === null) continue;
    roleByWorkspace.set(key, optionalString(membership.role));
    refs.set(key, ref);
  }
  for (const value of owned) {
    const key = recordKey(value);
    const ref = toStringRecordId(value);
    if (key === null || ref === null || refs.has(key)) continue;
    refs.set(key, ref);
  }

  const workspaces: TestSubjectPreflightWorkspace[] = [];
  const blockers: TestSubjectPreflightBlocker[] = [];
  for (const [key, wid] of refs) {
    const ws = rows(await db.query(
      `SELECT slug, name, db_name, owner_subject, test_expires_at FROM workspace WHERE id = $wid LIMIT 1;`,
      { wid },
    ))[0];
    const memberCount = Number(rows(await db.query(
      `SELECT count() AS n FROM user_workspace_index WHERE workspace = $wid GROUP ALL;`,
      { wid },
    ))[0]?.n ?? 0);
    const role = roleByWorkspace.get(key) ?? null;
    const isOwner = ws !== undefined && ws.owner_subject === subject;
    const isMember = roleByWorkspace.has(key);
    // 与 PUT 回填一致：该 subject 是成员且索引只有一行。
    const wouldBeMarked = isMember && memberCount === 1;
    const testExpiresAt = ws === undefined ? null : isoOrNull(ws.test_expires_at);
    const entry: TestSubjectPreflightWorkspace = {
      id: key,
      slug: ws === undefined ? null : optionalString(ws.slug),
      name: ws === undefined ? null : optionalString(ws.name),
      dbName: ws === undefined ? null : optionalString(ws.db_name),
      role,
      isOwner,
      memberCount,
      testExpiresAt,
      wouldBeMarked,
      newlyMarked: wouldBeMarked && testExpiresAt === null,
      membershipRemovedOnExpiry: isMember && memberCount > 1,
    };
    workspaces.push(entry);
    const hasOthers = memberCount > (isMember ? 1 : 0);
    if (hasOthers && (isOwner || role === "admin")) {
      blockers.push({
        code: "shared-workspace-admin",
        message: `该 subject 是含其他成员的工作区 ${entry.slug ?? key} 的 ${isOwner ? "owner" : "admin"}，不能登记为测试主体`,
        workspace: entry.slug ?? key,
      });
    }
  }
  workspaces.sort((left, right) => String(left.slug ?? left.id).localeCompare(String(right.slug ?? right.id)));

  // 已登记的运营主体一律拒绝（与旧行为一致，且不区分 status）；唯一例外是本 API
  // 早先为测试主体创建的 agent 行（test_subject 已存在且 kind = agent）。
  if (platformOperator !== null && !(existing !== null && platformOperator.kind === "agent")) {
    blockers.push({
      code: "active-platform-operator",
      message: platformOperator.status === "active"
        ? "该 subject 是有效的平台运营主体，不能登记为测试主体"
        : "该 subject 已是登记在案的平台运营主体，不能登记为测试主体",
    });
  }

  const billingRows = rows(await db.query(
    `SELECT id FROM billing_account WHERE account_key = $key;`,
    { key: `personal:${subject}` },
  ));
  let subscriptionCount = 0;
  for (const billing of billingRows) {
    const bid = toStringRecordId(billing.id);
    if (bid === null) continue;
    subscriptionCount += Number(rows(await db.query(
      `SELECT count() AS n FROM quota_subscription WHERE billing_account = $bid GROUP ALL;`,
      { bid },
    ))[0]?.n ?? 0);
  }
  const personalBillingAccount = { exists: billingRows.length > 0, subscriptionCount };

  const warnings: string[] = [];
  for (const workspace of workspaces) {
    if (workspace.newlyMarked) {
      warnings.push(`工作区 ${workspace.slug ?? workspace.id} 只有该 subject 一个成员：登记后会写入 test_expires_at，到期时整库删除`);
    }
    if (workspace.membershipRemovedOnExpiry) {
      warnings.push(`工作区 ${workspace.slug ?? workspace.id} 有 ${workspace.memberCount} 个成员：工作区保留，但到期清理会删除该 subject 在此的成员索引`);
    }
  }
  if (existing === null && personalBillingAccount.exists) {
    warnings.push(`已有个人计费账户 personal:${subject}（${subscriptionCount} 个订阅）：到期清理会删除它及其订阅`);
  }

  return {
    subject,
    testSubject: existing === null
      ? null
      : {
        email: existing.email ?? null,
        expiresAt: isoOrNull(existing.expires_at),
        origin: existing.origin ?? null,
      },
    platformOperator,
    workspaces,
    personalBillingAccount,
    blockers,
    warnings,
    requiresConfirmation: warnings.length > 0,
    confirmationPhrase: confirmationPhraseFor(subject),
  };
}

/** 按 email 只读查找 subject（成员索引与测试主体登记），用于在登记前确认目标账号。 */
export async function lookupSubjectsByEmail(
  db: Queryable,
  email: string,
): Promise<{ subject: string; emails: string[]; workspaces: { slug: string | null; role: string | null }[]; testSubject: boolean }[]> {
  const normalized = email.trim().toLowerCase();
  const indexRows = rows(await db.query(
    `SELECT subject, email, role, workspace.slug AS slug FROM user_workspace_index
     WHERE email != NONE AND string::lowercase(email) = $email;`,
    { email: normalized },
  ));
  const testRows = rows(await db.query(
    `SELECT subject, email FROM test_subject WHERE email != NONE AND string::lowercase(email) = $email;`,
    { email: normalized },
  ));
  const bySubject = new Map<string, { subject: string; emails: Set<string>; workspaces: { slug: string | null; role: string | null }[]; testSubject: boolean }>();
  const entry = (subject: string) => {
    let value = bySubject.get(subject);
    if (value === undefined) {
      value = { subject, emails: new Set(), workspaces: [], testSubject: false };
      bySubject.set(subject, value);
    }
    return value;
  };
  for (const row of indexRows) {
    if (typeof row.subject !== "string") continue;
    const value = entry(row.subject);
    if (typeof row.email === "string") value.emails.add(row.email);
    value.workspaces.push({ slug: optionalString(row.slug), role: optionalString(row.role) });
  }
  for (const row of testRows) {
    if (typeof row.subject !== "string") continue;
    const value = entry(row.subject);
    if (typeof row.email === "string") value.emails.add(row.email);
    value.testSubject = true;
  }
  return [...bySubject.values()]
    .map((value) => ({ ...value, emails: [...value.emails] }))
    .sort((left, right) => left.subject.localeCompare(right.subject));
}
