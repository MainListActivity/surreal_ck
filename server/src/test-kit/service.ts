// 测试物料自助（运营 MCP test_kit_* 工具的服务层）。
//
// 持 test.provision 的 agent 只能在「自己开的测试账号」范围内操作：
//   - provision：经代办开通（InviteService）新建 IdP 用户 + trial workspace + 小额 AI 额度，
//     登记为 test_subject（origin = test-kit:<agent>），一次性返回激活链接（密码由激活页设置）。
//   - status：查询开通进度，完成后一次性收取激活链接。
//   - list / add_member / purge：只作用于本 agent 开的账号。
//
// 生命周期（刻意不做续跑）：
//   - 账号身份 = 邮箱。代办开通的幂等键只由邮箱派生，任何 agent 并发用同一邮箱都收敛到同一行；
//     行归先占到的 agent，其他 agent 一律 not_owned。开通前确认产品与 IdP 都没有这个邮箱。
//   - 只登记「本行建出的用户」：完成时 outcome=created，或 InviteService 在新建用户后立即落到行上的
//     idp_user_id。绝不按邮箱回查 IdP 认领用户。
//   - 不能正常完成的行（执行失败、或 processing 超过 STALE_MS 视为中断）不续跑，直接「收养」：
//     有 idp_user_id 就把该用户登记为测试主体（到期锚定行 created_at + 30 天），交给 reaper 清掉
//     它留下的 workspace 等产物；邮箱作废。没有 idp_user_id 说明还没建出用户，无产物可清。
//   - 清理（手动或到期 reaper）给开通行打 test_kit_purged_at，对账不再登记回来。

import { DateTime, StringRecordId } from "surrealdb";
import { createOpsInvitationSchema, type CreateOpsInvitation } from "@surreal-ck/shared";
import type { InviteResult, InviteService } from "../invitations/invite-service";
import { InviteError } from "../invitations/invite-service";
import type { MemberManager } from "../workspaces/member-manager";
import { findTestSubject, isExpired, type Queryable } from "../test-subjects/store";
import { computeTestSubjectPreflight, lookupSubjectsByEmail } from "../test-subjects/preflight";
import { purgeTestSubject, purgeTestWorkspace, type TestSubjectReaperDeps } from "../test-subjects/reaper";
import { dateTimeTimestamp } from "../db/surreal-values";
import { stableSha256 } from "../quota/canonical";

export class TestKitError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TestKitError";
  }
}

export type TestKitActor = Readonly<{ subject: string; kind?: string; capabilities: readonly string[] }>;

export const TEST_KIT_TTL_DAYS = 30;
export const TEST_KIT_AI_AMOUNT = 100;
const DAY_MS = 86_400_000;
/** processing 超过该时长视为执行中断（远大于代办开通的同步窗与续跑阈值）。 */
export const TEST_KIT_STALE_MS = 15 * 60_000;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const KEY_PREFIX = "test-kit:";

export type TestKitDeps = Readonly<{
  invites: Pick<InviteService, "provision" | "get" | "collect">;
  members: Pick<MemberManager, "addMember">;
  getSystemDb: () => Promise<Queryable>;
  /** 身份系统按邮箱查用户（仅用于开通前查重）；查不到返回 null，不可用时抛错。 */
  idpFindUser: (email: string) => Promise<{ id: string } | null>;
  reaperDeps: () => Promise<TestSubjectReaperDeps>;
  /** 整串匹配、忽略大小写；未配置 = 自助开通关闭。 */
  emailPattern?: string;
  maxActive?: number;
  quotaPlanRevisionId?: string;
  now?: () => Date;
}>;

type InviteRow = {
  key: string;
  operator: string;
  email: string;
  status: string;
  createdAtMs: number;
  /** InviteService 新建 IdP 用户后立即落下的用户 id（= 本行建出的用户）。 */
  idpUserId: string | null;
  purged: boolean;
  /** 已按失败/中断收养：对外终态恒为 failed，之后哪怕后台执行完成也不改口。 */
  adopted: boolean;
};

function rows(result: unknown): Record<string, unknown>[] {
  if (!Array.isArray(result) || !Array.isArray(result[0])) return [];
  return result[0] as Record<string, unknown>[];
}

function iso(value: unknown): string | null {
  const ms = dateTimeTimestamp(value);
  return ms > 0 ? new Date(ms).toISOString() : null;
}

function str(args: Record<string, unknown>, name: string, required = true): string | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === "") {
    if (required) throw new TestKitError("invalid_request", `${name} 必填`);
    return undefined;
  }
  if (typeof value !== "string") throw new TestKitError("invalid_request", `${name} 必须是字符串`);
  return value.trim();
}

const INVITE_ROW_FIELDS = "idempotency_key, operator_subject, email, status, created_at, idp_user_id, test_kit_purged_at, test_kit_adopted_at";

function toInviteRow(row: Record<string, unknown>): InviteRow {
  return {
    key: String(row.idempotency_key),
    operator: String(row.operator_subject),
    email: String(row.email),
    status: String(row.status),
    createdAtMs: dateTimeTimestamp(row.created_at),
    idpUserId: typeof row.idp_user_id === "string" && row.idp_user_id.length > 0 ? row.idp_user_id : null,
    purged: dateTimeTimestamp(row.test_kit_purged_at) > 0,
    adopted: dateTimeTimestamp(row.test_kit_adopted_at) > 0,
  };
}

/** 幂等键只由邮箱派生（不含 agent），同一邮箱无论谁开通都收敛到同一行。 */
function inviteKey(email: string): string {
  return `${KEY_PREFIX}${stableSha256(email.trim().toLowerCase()).slice(0, 32)}`;
}

export class TestKitService {
  private readonly now: () => Date;
  private readonly maxActive: number;
  private readonly emailRe: RegExp | null;

  constructor(private readonly deps: TestKitDeps) {
    this.now = deps.now ?? (() => new Date());
    this.maxActive = deps.maxActive ?? 10;
    let re: RegExp | null = null;
    if (deps.emailPattern) {
      try { re = new RegExp(`^(?:${deps.emailPattern})$`, "iu"); } catch { re = null; }
    }
    this.emailRe = re;
  }

  static originFor(agentSubject: string): string {
    return `test-kit:${agentSubject}`;
  }

  rules(actor: TestKitActor) {
    this.authorize(actor);
    return {
      enabled: this.emailRe !== null,
      emailPattern: this.emailRe ? this.deps.emailPattern : null,
      maxActive: this.maxActive,
      ttlDays: TEST_KIT_TTL_DAYS,
      plan: "trial",
      aiAllowance: TEST_KIT_AI_AMOUNT,
      origin: TestKitService.originFor(actor.subject),
      note: "一个邮箱只能开一次（失败、清理后都不能复用）；每个测试账号用一个新别名。",
    };
  }

  async provision(actor: TestKitActor, args: Record<string, unknown>) {
    this.authorize(actor);
    const emailRe = this.requireEnabled();
    const email = str(args, "email")!.toLowerCase();
    if (!EMAIL_RE.test(email) || !emailRe.test(email)) {
      throw new TestKitError("email_not_allowed", `邮箱不在测试物料允许范围内（须整串匹配 ${this.deps.emailPattern}）`);
    }
    const key = inviteKey(email);
    const db = await this.deps.getSystemDb();
    const existing = await this.inviteRow(db, key);
    if (existing) return this.report(actor, db, this.own(actor, existing));

    const displayName = str(args, "displayName")!;
    const workspaceSlug = str(args, "workspaceSlug")!;
    const workspaceName = str(args, "workspaceName", false) ?? displayName;
    if (displayName.length > 80 || workspaceName.length > 80) throw new TestKitError("invalid_request", "displayName/workspaceName 最长 80 字");
    if (!SLUG_RE.test(workspaceSlug)) throw new TestKitError("invalid_request", "workspaceSlug 须为小写 kebab-case，2–40 字符");

    await this.reconcile(actor, db);
    const active = await this.activeCount(db, actor);
    if (active >= this.maxActive) {
      throw new TestKitError("limit_reached", `未到期/开通中测试账号已有 ${active} 个（上限 ${this.maxActive}），先用 test_kit_purge 清理不用的`);
    }
    if ((await lookupSubjectsByEmail(db, email)).length > 0) {
      throw new TestKitError("email_in_use", "该邮箱已属于既有账号；测试物料只开新账号，请换一个未用过的邮箱");
    }
    const slugOwner = rows(await db.query(`SELECT VALUE owner_subject FROM workspace WHERE slug = $slug LIMIT 1;`, { slug: workspaceSlug }))[0];
    if (slugOwner !== undefined) throw new TestKitError("slug_taken", "workspaceSlug 已被占用，换一个");
    let idpHas: { id: string } | null;
    try {
      idpHas = await this.deps.idpFindUser(email);
    } catch {
      throw new TestKitError("idp_unavailable", "身份系统暂不可用，稍后重试");
    }
    if (idpHas) throw new TestKitError("email_in_use", "该邮箱在身份系统已有账号（含清理过的测试账号）；请换一个未用过的邮箱");

    const parsed = createOpsInvitationSchema.safeParse({
      email,
      displayName,
      workspaceSlug,
      workspaceName,
      planKey: "trial",
      quotaPlanRevisionId: this.deps.quotaPlanRevisionId ?? "quota_plan_revision:trial_v2",
      aiAllowance: {
        amount: TEST_KIT_AI_AMOUNT,
        expiresAt: new Date(this.now().getTime() + (TEST_KIT_TTL_DAYS + 1) * DAY_MS).toISOString(),
        label: "测试物料 AI 额度",
      },
      reason: `test-kit: agent ${actor.subject} 自助开通测试账号`,
      idempotencyKey: key,
    });
    if (!parsed.success) throw new TestKitError("invalid_request", "开通参数超出代办开通契约限制");
    const input: CreateOpsInvitation = parsed.data;
    let result: InviteResult | null;
    try {
      // 代办开通内部的权益分配以 subscription.manage 执行；对外能力仍只有 test.provision，
      // 输入已收窄到 trial/小额度/受限邮箱，审计行 operator_subject 记为该 agent。
      result = await this.deps.invites.provision({ subject: actor.subject, capabilities: ["subscription.manage"] }, input);
    } catch (error) {
      // 失败已落库（或别人抢先占了该邮箱的行）：按行的现状汇报，所有权照常校验。
      const row = await this.inviteRow(db, key).catch(() => null);
      if (row && row.status !== "processing") return this.report(actor, db, this.own(actor, row));
      if (error instanceof InviteError) throw new TestKitError(error.code, error.message);
      throw error;
    }
    const row = await this.inviteRow(db, key).catch(() => null);
    const activationUrl = result.delivery?.activationUrl ?? null;
    if (!row) return this.fallback(result, activationUrl);
    return this.settle(actor, db, this.own(actor, row), result, activationUrl);
  }

  async status(actor: TestKitActor, args: Record<string, unknown>) {
    this.authorize(actor);
    const email = str(args, "email")!.toLowerCase();
    const db = await this.deps.getSystemDb();
    const row = await this.inviteRow(db, inviteKey(email));
    if (!row) throw new TestKitError("not_found", "本 agent 没有该邮箱的开通记录");
    return this.report(actor, db, this.own(actor, row));
  }

  async list(actor: TestKitActor) {
    this.authorize(actor);
    const db = await this.deps.getSystemDb();
    await this.reconcile(actor, db);
    const subjects = rows(await db.query(
      `SELECT subject, email, expires_at FROM test_subject WHERE origin = $origin ORDER BY expires_at;`,
      { origin: TestKitService.originFor(actor.subject) },
    ));
    const now = this.now();
    const out = [] as Record<string, unknown>[];
    for (const row of subjects) {
      const workspaces = rows(await db.query(
        `SELECT workspace.slug AS slug, role FROM user_workspace_index WHERE subject = $subject;`,
        { subject: row.subject },
      ));
      out.push({
        subject: row.subject,
        email: row.email ?? null,
        expiresAt: iso(row.expires_at),
        expired: isExpired({ expires_at: row.expires_at as string }, now),
        workspaces: workspaces.map((w) => ({ slug: w.slug ?? null, role: w.role ?? null })),
      });
    }
    const inFlight = (await this.myInviteRows(db, actor, `status = "processing"`))
      .filter((row) => !this.stale(row))
      .map((row) => ({ email: row.email, status: row.status, next: "稍后用该 email 调 test_kit_status" }));
    return { maxActive: this.maxActive, subjects: out, inFlight };
  }

  async addMember(actor: TestKitActor, args: Record<string, unknown>) {
    this.authorize(actor);
    const workspaceSlug = str(args, "workspaceSlug")!;
    const email = str(args, "email")!.toLowerCase();
    const isAdmin = args.isAdmin === true;
    const mine = TestKitService.originFor(actor.subject);
    const db = await this.deps.getSystemDb();
    const now = this.now();
    const ws = rows(await db.query(
      `SELECT owner_subject, test_expires_at FROM workspace WHERE slug = $slug LIMIT 1;`,
      { slug: workspaceSlug },
    ))[0];
    if (!ws) throw new TestKitError("not_found", "workspace 不存在");
    if (!(dateTimeTimestamp(ws.test_expires_at) > now.getTime())) throw new TestKitError("not_test_workspace", "只能操作已登记到期清理的测试 workspace");
    const owner = typeof ws.owner_subject === "string" ? await findTestSubject(db, ws.owner_subject) : null;
    if (!owner || isExpired(owner, now)) throw new TestKitError("not_test_workspace", "该 workspace 的所有者不是未到期测试账号");
    const ownerIsMine = owner.origin === mine;
    // 别的 agent 开的账号不碰；运营登记的测试账号（非 test-kit 来源）的 workspace 可以加入，但只能做普通成员。
    if (!ownerIsMine && typeof owner.origin === "string" && owner.origin.startsWith("test-kit:")) {
      throw new TestKitError("not_owned", "该 workspace 属于其他 agent 开的测试账号");
    }
    if (isAdmin && !ownerIsMine) throw new TestKitError("not_owned", "只有本 agent 开的 workspace 才能加管理员");
    const member = rows(await db.query(
      `SELECT subject, expires_at FROM test_subject WHERE origin = $origin AND email != NONE AND string::lowercase(email) = $email;`,
      { email, origin: mine },
    )).find((row) => !isExpired({ expires_at: row.expires_at as string }, now));
    if (!member) throw new TestKitError("not_test_subject", "被加入的邮箱必须是本 agent 开的未到期测试账号（先用 test_kit_provision 开通）");
    const result = await this.deps.members.addMember({
      callerSubject: String(ws.owner_subject),
      slug: workspaceSlug,
      email,
      displayName: str(args, "displayName", false),
      isAdmin,
    });
    if (result.kind === "workspace-not-found") throw new TestKitError("not_found", "workspace 不存在");
    if (result.kind === "forbidden") throw new TestKitError("forbidden", "workspace 所有者已不是管理员，无法代加成员");
    return { workspaceSlug, email, role: isAdmin ? "admin" : "participant", added: true, next: "被加入者首次登录后自动绑定" };
  }

  async purge(actor: TestKitActor, args: Record<string, unknown>) {
    this.authorize(actor);
    const subject = str(args, "subject")!;
    if (args.confirm !== `purge ${subject}`) {
      throw new TestKitError("confirmation_required", `不可逆：整库删除该账号自己拥有的 workspace。确认请在 confirm 原样填写「purge ${subject}」`);
    }
    const db = await this.deps.getSystemDb();
    const row = await findTestSubject(db, subject);
    if (!row || row.origin !== TestKitService.originFor(actor.subject)) {
      throw new TestKitError("not_owned", "只能清理本 agent 经 test_kit_provision 开通的测试账号");
    }
    // 先打清理标记（purgeTestSubject 末尾也会打）：中途失败也不会被对账登记回来。
    if (row.email) {
      await db.query(`UPDATE ops_invitation SET test_kit_purged_at = time::now() WHERE idempotency_key = $key;`, { key: inviteKey(row.email) });
    }
    const deps = await this.deps.reaperDeps();
    // 只删该账号自己拥有的 workspace；它被加入的别人的测试 workspace 只摘成员索引（purgeTestSubject）。
    const workspaces = rows(await db.query(`SELECT VALUE id FROM workspace WHERE owner_subject = $subject;`, { subject }));
    let workspacesPurged = 0;
    let workspacesSkipped = 0;
    for (const ref of workspaces) {
      if ((await purgeTestWorkspace(deps, String(ref))) === "purged") workspacesPurged += 1;
      else workspacesSkipped += 1;
    }
    await purgeTestSubject(deps, subject);
    return { subject, workspacesPurged, workspacesSkipped };
  }

  // ---- internals ----

  private authorize(actor: TestKitActor): void {
    if (!actor.capabilities.includes("test.provision")) {
      throw new TestKitError("forbidden", "需要 test.provision 能力（授权连接器时勾选 test.provision scope）");
    }
  }

  private requireEnabled(): RegExp {
    if (!this.emailRe) throw new TestKitError("disabled", "测试物料自助未启用（TEST_KIT_EMAIL_PATTERN 未配置）");
    return this.emailRe;
  }

  private own(actor: TestKitActor, row: InviteRow): InviteRow {
    if (row.operator !== actor.subject) throw new TestKitError("not_owned", "该邮箱已被其他 agent 用于开通测试账号；换一个新别名");
    return row;
  }

  private stale(row: InviteRow): boolean {
    return row.status === "processing" && this.now().getTime() - row.createdAtMs > TEST_KIT_STALE_MS;
  }

  private async inviteRow(db: Queryable, key: string): Promise<InviteRow | null> {
    const row = rows(await db.query(`SELECT ${INVITE_ROW_FIELDS} FROM ops_invitation WHERE idempotency_key = $key LIMIT 1;`, { key }))[0];
    return row ? toInviteRow(row) : null;
  }

  private async myInviteRows(db: Queryable, actor: TestKitActor, where: string): Promise<InviteRow[]> {
    return rows(await db.query(
      `SELECT ${INVITE_ROW_FIELDS} FROM ops_invitation
       WHERE operator_subject = $agent AND string::starts_with(idempotency_key, $prefix) AND test_kit_purged_at = NONE AND ${where};`,
      { agent: actor.subject, prefix: KEY_PREFIX },
    )).map(toInviteRow);
  }

  /** 已有开通行的现状：已清理 → 拒绝；中断 → 收养；其余按 InviteService 记录结算并补收链接。 */
  private async report(actor: TestKitActor, db: Queryable, row: InviteRow) {
    if (row.purged) throw new TestKitError("purged", "该邮箱的测试账号已清理，不能复用；换一个新别名");
    if (row.adopted || this.stale(row)) return this.adopt(actor, db, row);
    const result = await this.deps.invites.get(row.key);
    if (!result) throw new TestKitError("not_found", "开通记录不存在");
    const settled = await this.settle(actor, db, row, result, null);
    if (settled.status !== "completed" || settled.activationUrl) return settled;
    const collected = await this.deps.invites.collect(row.key);
    return { ...settled, activationUrl: collected?.activationUrl ?? null };
  }

  private fallback(result: InviteResult, activationUrl: string | null) {
    if (!activationUrl) throw new TestKitError("internal", "开通结果暂不可读，稍后用该 email 调 test_kit_status");
    return {
      email: result.user?.email ?? "", status: result.status as string, subject: result.user?.id ?? null,
      workspace: result.workspace?.slug ?? null, activationUrl, registered: false,
      warning: "测试主体登记未完成；稍后调 test_kit_list 会自动补登记",
    };
  }

  /** 把一次开通结果落成测试主体登记；任何结算错误都不吞掉已到手的一次性激活链接。 */
  private async settle(actor: TestKitActor, db: Queryable, row: InviteRow, result: InviteResult, activationUrl: string | null) {
    try {
      return await this.settleInner(actor, db, row, result, activationUrl);
    } catch (error) {
      if (!activationUrl) throw error;
      return this.fallback(result, activationUrl);
    }
  }

  private async settleInner(actor: TestKitActor, db: Queryable, row: InviteRow, result: InviteResult, activationUrl: string | null) {
    const base = { email: row.email, status: result.status as string };
    if (result.status === "processing") {
      if (this.stale(row)) return this.adopt(actor, db, row);
      return { ...base, activationUrl: null, next: "开通进行中：稍后用同一 email 调 test_kit_status" };
    }
    if (row.adopted || result.status === "failed" || !result.user) return this.adopt(actor, db, row);
    // 行已由 own() 确认归本 agent；只登记本行建出的用户（新建，或行上记下的新建用户 id）。
    const ours = result.user.outcome === "created" || row.idpUserId === result.user.id;
    if (!ours) throw new TestKitError("email_in_use", "该邮箱在身份系统已有账号，未登记为测试账号；请换一个未用过的邮箱");
    const expiresAt = this.expiry(row);
    await this.register(actor, db, result.user.id, row.email, expiresAt);
    return {
      ...base,
      subject: result.user.id,
      workspace: result.workspace?.slug ?? null,
      expiresAt: expiresAt.toISOString(),
      activationUrl,
      next: activationUrl
        ? "在浏览器打开 activationUrl 设置密码（链接一次性，24 小时内有效）"
        : "激活链接已下发过（只能收取一次）",
    };
  }

  /** 失败或中断的行：登记本行建出的用户交给 reaper 清理（没建出用户则无产物），邮箱作废。 */
  private async adopt(actor: TestKitActor, db: Queryable, row: InviteRow) {
    if (!row.adopted) {
      await db.query(`UPDATE ops_invitation SET test_kit_adopted_at = time::now() WHERE idempotency_key = $key AND test_kit_adopted_at = NONE;`, { key: row.key });
    }
    // 收养后后台执行仍可能完成并建出 workspace：每次都重新登记（幂等）并补标记它的 workspace。
    if (row.idpUserId) await this.register(actor, db, row.idpUserId, row.email, this.expiry(row));
    return {
      email: row.email,
      status: "failed",
      activationUrl: null,
      next: "开通失败或中断，该邮箱作废（已建出的账号会到期自动清理）；换一个新别名重试",
    };
  }

  private expiry(row: InviteRow): Date {
    // 到期锚定开通行创建时刻：补登记、收养都不延长寿命；已过期的直接交给下一轮 reaper。
    return new Date((row.createdAtMs || this.now().getTime()) + TEST_KIT_TTL_DAYS * DAY_MS);
  }

  /** 本 agent 的开通行里，已结束（或中断）、未清理、尚未登记的：补登记。 */
  private async reconcile(actor: TestKitActor, db: Queryable): Promise<void> {
    const candidates = await this.myInviteRows(db, actor, `created_at > time::now() - 32d`);
    const known = new Set(rows(await db.query(
      `SELECT VALUE string::lowercase(email) FROM test_subject WHERE origin = $origin AND email != NONE;`,
      { origin: TestKitService.originFor(actor.subject) },
    )).map(String));
    for (const row of candidates) {
      // 已登记的正常行跳过；收养过的行每次都过一遍，以标记后台执行迟到建出的 workspace。
      if (known.has(row.email.toLowerCase()) && !row.adopted) continue;
      if (row.status === "processing" && !this.stale(row)) continue;
      await (async () => {
        if (row.adopted || this.stale(row)) return this.adopt(actor, db, row);
        const result = await this.deps.invites.get(row.key);
        if (result) await this.settleInner(actor, db, row, result, null);
      })().catch(() => undefined);
    }
  }

  private async activeCount(db: Queryable, actor: TestKitActor): Promise<number> {
    const list = rows(await db.query(
      `SELECT expires_at FROM test_subject WHERE origin = $origin;`,
      { origin: TestKitService.originFor(actor.subject) },
    ));
    const now = this.now();
    const processing = (await this.myInviteRows(db, actor, `status = "processing"`)).filter((row) => !this.stale(row));
    return list.filter((row) => !isExpired({ expires_at: row.expires_at as string }, now)).length + processing.length;
  }

  private async register(actor: TestKitActor, db: Queryable, subject: string, email: string, expiresAt: Date): Promise<void> {
    const origin = TestKitService.originFor(actor.subject);
    const existing = await findTestSubject(db, subject);
    if (existing && existing.origin !== origin) throw new TestKitError("not_owned", "该账号已由他处登记为测试主体");
    const preflight = await computeTestSubjectPreflight(db, subject);
    if (!existing) {
      if (preflight.blockers.length > 0) {
        throw new TestKitError(`conflict-${preflight.blockers[0]!.code}`, preflight.blockers[0]!.message);
      }
      await db.query(
        `INSERT INTO test_subject { subject: $subject, email: $email, expires_at: $expiresAt, origin: $origin }
         ON DUPLICATE KEY UPDATE updated_at = time::now();`,
        { subject, email, expiresAt: new DateTime(expiresAt), origin },
      );
    }
    // 已登记也要补标记：收养后后台执行迟到建出的 workspace 必须进入到期清理。
    const until = existing ? new Date(dateTimeTimestamp(existing.expires_at)) : expiresAt;
    for (const workspace of preflight.workspaces) {
      if (!workspace.wouldBeMarked) continue;
      await db.query(
        `UPDATE $wid SET test_expires_at = $expiresAt, test_origin = $origin;`,
        { wid: new StringRecordId(workspace.id), expiresAt: new DateTime(until), origin },
      );
    }
  }
}
