// 测试物料自助（运营 MCP test_kit_* 工具的服务层）。
//
// 持 test.provision 的 agent 只能做这几件事，且全部落在「测试账号」范围内：
//   - provision：经代办开通（InviteService）新建一个 IdP 用户 + trial workspace + 小额 AI 额度，
//     随即登记为 test_subject（origin = test-kit:<agent>，30 天到期由 reaper 整库清理），
//     一次性返回激活链接（密码由激活页设置，任何接口都不经手明文密码）。
//   - status：轮询开通进度，完成后一次性收取激活链接。
//   - list：只列本 agent 开的测试账号。
//   - add_member：把一个未到期测试账号加入另一个未到期测试账号拥有的测试 workspace。
//   - purge：立即清理本 agent 开的测试账号（与 DELETE /api/ops/test-subjects 同一 reaper 路径）。
//
// 边界：邮箱必须整串匹配 TEST_KIT_EMAIL_PATTERN（未配置则全部关闭）；邮箱已属于任何既有主体
// （IdP 复用）一律拒绝且不登记；每个 agent 未到期测试账号 ≤ TEST_KIT_MAX_ACTIVE；套餐固定 trial。

import { DateTime, StringRecordId } from "surrealdb";
import { createOpsInvitationSchema, type CreateOpsInvitation } from "@surreal-ck/shared";
import type { InviteResult, InviteService } from "../invitations/invite-service";
import { InviteError } from "../invitations/invite-service";
import type { MemberManager } from "../workspaces/member-manager";
import { findTestSubject, isExpired, type Queryable } from "../test-subjects/store";
import { computeTestSubjectPreflight, lookupSubjectsByEmail } from "../test-subjects/preflight";
import { purgeTestSubject, purgeTestWorkspace, type TestSubjectReaperDeps } from "../test-subjects/reaper";
import { dateTimeTimestamp } from "../db/surreal-values";

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
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;
const KEY_RE = /^[A-Za-z0-9._:-]{1,64}$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export type TestKitDeps = Readonly<{
  invites: Pick<InviteService, "provision" | "get" | "collect">;
  members: Pick<MemberManager, "addMember">;
  getSystemDb: () => Promise<Queryable>;
  /** 身份系统里是否已有该邮箱的用户（有则代办开通会复用，测试物料一律拒绝）。 */
  idpUserExists: (email: string) => Promise<boolean>;
  reaperDeps: () => Promise<TestSubjectReaperDeps>;
  /** 整串匹配、忽略大小写；未配置 = 自助开通关闭。 */
  emailPattern?: string;
  maxActive?: number;
  quotaPlanRevisionId?: string;
  now?: () => Date;
}>;

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

  /** 工具说明里展示的规则（不含正则本身以外的任何配置细节）。 */
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
    };
  }

  async provision(actor: TestKitActor, args: Record<string, unknown>) {
    this.authorize(actor);
    const emailRe = this.requireEnabled();
    const email = str(args, "email")!.toLowerCase();
    const displayName = str(args, "displayName")!;
    const workspaceSlug = str(args, "workspaceSlug")!;
    const workspaceName = str(args, "workspaceName", false);
    const idempotencyKey = str(args, "idempotencyKey")!;
    if (!EMAIL_RE.test(email) || !emailRe.test(email)) {
      throw new TestKitError("email_not_allowed", `邮箱不在测试物料允许范围内（须整串匹配 ${this.deps.emailPattern}）`);
    }
    if (displayName.length > 80) throw new TestKitError("invalid_request", "displayName 最长 80 字");
    if (workspaceName !== undefined && workspaceName.length > 80) throw new TestKitError("invalid_request", "workspaceName 最长 80 字");
    if (!SLUG_RE.test(workspaceSlug)) throw new TestKitError("invalid_request", "workspaceSlug 须为小写 kebab-case，2–40 字符");
    if (!KEY_RE.test(idempotencyKey)) throw new TestKitError("invalid_request", "idempotencyKey 只允许字母数字与 ._:-，最长 64");

    const key = this.inviteKey(actor, idempotencyKey);
    const existing = await this.deps.invites.get(key);
    // 已完成/失败 → 只结算；processing → 原样重发，让 InviteService 接管僵死行续跑。
    if (existing && existing.status !== "processing") return this.settle(actor, existing, null);

    const db = await this.deps.getSystemDb();
    if (!existing) {
      await this.settlePending(actor, db);
      const active = await this.activeCount(db, actor);
      if (active >= this.maxActive) {
        throw new TestKitError("limit_reached", `未到期/开通中测试账号已有 ${active} 个（上限 ${this.maxActive}），先用 test_kit_purge 清理不用的`);
      }
      if ((await lookupSubjectsByEmail(db, email)).length > 0) {
        throw new TestKitError("email_in_use", "该邮箱已属于既有账号；测试物料只开新账号，请换一个未用过的邮箱");
      }
      const slugOwner = rows(await db.query(`SELECT VALUE owner_subject FROM workspace WHERE slug = $slug LIMIT 1;`, { slug: workspaceSlug }))[0];
      if (slugOwner !== undefined) throw new TestKitError("slug_taken", "workspaceSlug 已被占用，换一个");
      let idpHas: boolean;
      try {
        idpHas = await this.deps.idpUserExists(email);
      } catch {
        throw new TestKitError("idp_unavailable", "身份系统暂不可用，稍后重试");
      }
      if (idpHas) {
        throw new TestKitError("email_in_use", "该邮箱在身份系统已有账号（含清理过的测试账号）；测试物料只开新账号，请换一个未用过的邮箱");
      }
    }

    // 额度到期按 UTC 日取整：同一天内用同一 key 重发得到相同请求摘要，可续跑僵死的开通。
    const dayStart = Math.floor(this.now().getTime() / DAY_MS) * DAY_MS;
    const parsed = createOpsInvitationSchema.safeParse({
      email,
      displayName,
      workspaceSlug,
      ...(workspaceName ? { workspaceName } : {}),
      planKey: "trial",
      quotaPlanRevisionId: this.deps.quotaPlanRevisionId ?? "quota_plan_revision:trial_v2",
      aiAllowance: {
        amount: TEST_KIT_AI_AMOUNT,
        expiresAt: new Date(dayStart + (TEST_KIT_TTL_DAYS + 1) * DAY_MS).toISOString(),
        label: "测试物料 AI 额度",
      },
      reason: `test-kit: agent ${actor.subject} 自助开通测试账号`,
      idempotencyKey: key,
    });
    if (!parsed.success) throw new TestKitError("invalid_request", "开通参数超出代办开通契约限制");
    const input: CreateOpsInvitation = parsed.data;
    let result: InviteResult;
    try {
      // 代办开通内部步骤（产品权益分配）以 subscription.manage 执行；对外能力仍只有 test.provision，
      // 输入已被本服务收窄到 trial/小额度/受限邮箱，审计行 operator_subject 记为该 agent。
      result = await this.deps.invites.provision({ subject: actor.subject, capabilities: ["subscription.manage"] }, input);
    } catch (error) {
      if (error instanceof InviteError && error.code === "invite-conflict" && existing) {
        // 跨日重发（请求摘要不同）：不再续跑，按现状结算。
        return this.settle(actor, existing, null);
      }
      if (error instanceof InviteError) throw new TestKitError(error.code, error.message);
      throw error;
    }
    return this.settle(actor, result, result.delivery?.activationUrl ?? null);
  }

  async status(actor: TestKitActor, args: Record<string, unknown>) {
    this.authorize(actor);
    const idempotencyKey = str(args, "idempotencyKey")!;
    const key = this.inviteKey(actor, idempotencyKey);
    const row = await this.deps.invites.get(key);
    if (!row) throw new TestKitError("not_found", "没有这个 idempotencyKey 的开通记录");
    const settled = await this.settle(actor, row, null);
    if (settled.status !== "completed") return settled;
    const collected = await this.deps.invites.collect(key);
    return {
      ...settled,
      activationUrl: collected?.activationUrl ?? null,
      activationUrlDeliveredAt: collected?.deliveredAt ?? null,
    };
  }

  async list(actor: TestKitActor) {
    this.authorize(actor);
    const db = await this.deps.getSystemDb();
    await this.settlePending(actor, db);
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
    const inFlight = rows(await db.query(
      `SELECT idempotency_key, status, email FROM ops_invitation WHERE operator_subject = $agent AND string::starts_with(idempotency_key, $prefix) AND status = "processing";`,
      { agent: actor.subject, prefix: this.inviteKey(actor, "") },
    )).map((row) => ({ idempotencyKey: String(row.idempotency_key).slice(this.inviteKey(actor, "").length), email: row.email ?? null, status: row.status }));
    return { maxActive: this.maxActive, subjects: out, inFlight };
  }

  async addMember(actor: TestKitActor, args: Record<string, unknown>) {
    this.authorize(actor);
    const workspaceSlug = str(args, "workspaceSlug")!;
    const email = str(args, "email")!.toLowerCase();
    const isAdmin = args.isAdmin === true;
    const db = await this.deps.getSystemDb();
    const now = this.now();
    const ws = rows(await db.query(
      `SELECT owner_subject, test_expires_at FROM workspace WHERE slug = $slug LIMIT 1;`,
      { slug: workspaceSlug },
    ))[0];
    if (!ws) throw new TestKitError("not_found", "workspace 不存在");
    const wsExpiry = dateTimeTimestamp(ws.test_expires_at);
    if (!(wsExpiry > now.getTime())) throw new TestKitError("not_test_workspace", "只能操作已登记到期清理的测试 workspace");
    const owner = typeof ws.owner_subject === "string" ? await findTestSubject(db, ws.owner_subject) : null;
    if (!owner || isExpired(owner, now)) throw new TestKitError("not_test_workspace", "该 workspace 的所有者不是未到期测试账号");
    const member = rows(await db.query(
      `SELECT subject, email, expires_at FROM test_subject WHERE email != NONE AND string::lowercase(email) = $email;`,
      { email },
    )).find((row) => !isExpired({ expires_at: row.expires_at as string }, now));
    if (!member) throw new TestKitError("not_test_subject", "被加入的邮箱必须是未到期测试账号（先用 test_kit_provision 开通）");
    const result = await this.deps.members.addMember({
      callerSubject: String(ws.owner_subject),
      slug: workspaceSlug,
      email,
      displayName: str(args, "displayName", false),
      isAdmin,
    });
    if (result.kind === "workspace-not-found") throw new TestKitError("not_found", "workspace 不存在");
    if (result.kind === "forbidden") throw new TestKitError("forbidden", "workspace 所有者已不是管理员，无法代加成员");
    return { workspaceSlug, email, role: isAdmin ? "admin" : "participant", added: true };
  }

  async purge(actor: TestKitActor, args: Record<string, unknown>) {
    this.authorize(actor);
    const subject = str(args, "subject")!;
    if (args.confirm !== `purge ${subject}`) {
      throw new TestKitError("confirmation_required", `不可逆：整库删除该账号独占的 workspace。确认请在 confirm 原样填写「purge ${subject}」`);
    }
    const db = await this.deps.getSystemDb();
    const row = await findTestSubject(db, subject);
    if (!row || row.origin !== TestKitService.originFor(actor.subject)) {
      throw new TestKitError("not_owned", "只能清理本 agent 经 test_kit_provision 开通的测试账号");
    }
    const deps = await this.deps.reaperDeps();
    // 只删该账号自己拥有的 workspace；它被加入的别人的测试 workspace 只摘成员索引（purgeTestSubject）。
    const workspaces = rows(await db.query(
      `SELECT VALUE id FROM workspace WHERE owner_subject = $subject;`,
      { subject },
    ));
    let workspacesPurged = 0;
    let workspacesSkipped = 0;
    for (const ref of workspaces) {
      if ((await purgeTestWorkspace(deps, String(ref))) === "purged") workspacesPurged += 1;
      else workspacesSkipped += 1;
    }
    await purgeTestSubject(deps, subject);
    return { subject, workspacesPurged, workspacesSkipped, membershipsRemoved: true };
  }

  private authorize(actor: TestKitActor): void {
    if (!actor.capabilities.includes("test.provision")) {
      throw new TestKitError("forbidden", "需要 test.provision 能力（授权连接器时勾选 test.provision scope）");
    }
  }

  private requireEnabled(): RegExp {
    if (!this.emailRe) throw new TestKitError("disabled", "测试物料自助未启用（TEST_KIT_EMAIL_PATTERN 未配置）");
    return this.emailRe;
  }

  private inviteKey(actor: TestKitActor, idempotencyKey: string): string {
    return `test-kit:${actor.subject}:${idempotencyKey}`;
  }

  private async activeCount(db: Queryable, actor: TestKitActor): Promise<number> {
    const list = rows(await db.query(
      `SELECT expires_at FROM test_subject WHERE origin = $origin;`,
      { origin: TestKitService.originFor(actor.subject) },
    ));
    const now = this.now();
    const processing = rows(await db.query(
      `SELECT VALUE idempotency_key FROM ops_invitation WHERE operator_subject = $agent AND string::starts_with(idempotency_key, $prefix) AND status = "processing";`,
      { agent: actor.subject, prefix: this.inviteKey(actor, "") },
    ));
    return list.filter((row) => !isExpired({ expires_at: row.expires_at as string }, now)).length + processing.length;
  }

  /** 已完成但未登记（同步窗超时后从未调 status）的开通：补登记，避免成为不受清理的孤儿。 */
  private async settlePending(actor: TestKitActor, db: Queryable): Promise<void> {
    const prefix = this.inviteKey(actor, "");
    const keys = rows(await db.query(
      `SELECT VALUE idempotency_key FROM ops_invitation WHERE operator_subject = $agent AND string::starts_with(idempotency_key, $prefix) AND status = "completed";`,
      { agent: actor.subject, prefix },
    ));
    for (const key of keys) {
      const row = await this.deps.invites.get(String(key));
      if (!row?.user || (await findTestSubject(db, row.user.id))) continue;
      await this.settle(actor, row, null).catch(() => undefined);
    }
  }

  /** 开通完成 → 登记为本 agent 的测试主体（幂等）；复用既有 IdP 用户的一律不登记。 */
  private async settle(actor: TestKitActor, result: InviteResult, activationUrl: string | null) {
    const base = {
      idempotencyKey: result.idempotencyKey.slice(this.inviteKey(actor, "").length),
      status: result.status,
    };
    if (result.status === "processing") {
      return { ...base, activationUrl: null, next: "开通进行中：稍后用同一 idempotencyKey 调 test_kit_status" };
    }
    if (result.status === "failed" || !result.user) {
      return { ...base, status: "failed" as const, activationUrl: null, error: "开通失败；换一个 idempotencyKey 重试，或把该 key 报给运营" };
    }
    if (result.user.outcome !== "created") {
      throw new TestKitError("email_in_use", "该邮箱在身份系统已有账号，未登记为测试账号；请换一个未用过的邮箱");
    }
    const db = await this.deps.getSystemDb();
    if (!(await findTestSubject(db, result.user.id))) {
      const owned = rows(await db.query(
        `SELECT VALUE owner_subject FROM workspace WHERE slug = $slug LIMIT 1;`,
        { slug: result.workspace?.slug ?? "" },
      ))[0];
      // 已被 test_kit_purge 清理（workspace 已删）：不复活登记。
      if ((owned as unknown) !== result.user.id) return { ...base, status: "purged" as const, activationUrl: null };
    }
    const registered = await this.register(actor, result.user.id, result.user.email);
    return {
      ...base,
      subject: result.user.id,
      email: result.user.email,
      workspace: result.workspace?.slug ?? null,
      expiresAt: registered.expiresAt,
      activationUrl,
      next: activationUrl
        ? "在浏览器打开 activationUrl 设置密码（链接一次性，24 小时内有效）"
        : "激活链接已下发过；未收到时调 test_kit_status 再收取一次（仅能收取一次）",
    };
  }

  private async register(actor: TestKitActor, subject: string, email: string): Promise<{ expiresAt: string }> {
    const db = await this.deps.getSystemDb();
    const origin = TestKitService.originFor(actor.subject);
    const existing = await findTestSubject(db, subject);
    if (existing) {
      if (existing.origin !== origin) throw new TestKitError("not_owned", "该账号已由他处登记为测试主体");
      return { expiresAt: iso(existing.expires_at) ?? "" };
    }
    const preflight = await computeTestSubjectPreflight(db, subject);
    if (preflight.blockers.length > 0) {
      throw new TestKitError(`conflict-${preflight.blockers[0]!.code}`, preflight.blockers[0]!.message);
    }
    const expiresAt = new Date(this.now().getTime() + TEST_KIT_TTL_DAYS * DAY_MS);
    await db.query(
      `INSERT INTO test_subject { subject: $subject, email: $email, expires_at: $expiresAt, origin: $origin }
       ON DUPLICATE KEY UPDATE updated_at = time::now();`,
      { subject, email, expiresAt: new DateTime(expiresAt), origin },
    );
    for (const workspace of preflight.workspaces) {
      if (!workspace.wouldBeMarked) continue;
      await db.query(
        `UPDATE $wid SET test_expires_at = $expiresAt, test_origin = $origin;`,
        { wid: new StringRecordId(workspace.id), expiresAt: new DateTime(expiresAt), origin },
      );
    }
    return { expiresAt: expiresAt.toISOString() };
  }
}
