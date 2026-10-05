import type { CreateOpsInvitation } from "@surreal-ck/shared";
import { stableSha256 } from "../quota/canonical";
import type { PlatformOperatorCapability } from "@surreal-ck/shared/native-quota";
import type { WorkspaceCreator } from "../workspaces/create-workspace";
import type { ProductEntitlementService } from "../product-entitlement/service";
import type { AiAllowanceService } from "../ai-allowance/service";
import type { EnsureUserResult, HttpIdpAdminClient, IdpAdminClientSource } from "./idp-admin-client";
import { IdpAdminError } from "./idp-admin-client";
import type { InviteAuditStore, InviteAuditRow, InviteOutcome } from "./invite-store";

export class InviteError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InviteError";
  }
}

export type InviteActor = Readonly<{
  subject: string;
  capabilities: readonly PlatformOperatorCapability[];
}>;

export type InviteCollect = Readonly<{
  idempotencyKey: string;
  status: "processing" | "completed" | "failed";
  /** 一次性收取：仅首次成功 collect 返回 URL，其余情况为 null。 */
  activationUrl: string | null;
  /** 已被收取过的时刻；从未收取为 null。 */
  deliveredAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}>;

export type InviteResult = Readonly<{
  idempotencyKey: string;
  status: "completed" | "failed" | "processing";
  replayed: boolean;
  user: {
    id: string;
    email: string;
    status: string;
    outcome: "created" | "reused";
  } | null;
  workspace: {
    slug: string;
    dbName: string;
    outcome: "created" | "reused";
  } | null;
  entitlement: {
    planKey: string;
    productPlanRevisionId: string;
    billingAccountKey: string;
  } | null;
  aiAllowance: InviteOutcome["aiAllowance"] | null;
  delivery: {
    channel: "activation_url" | "email" | "none";
    /** 一次性激活链接：仅「任务完成且链接尚未被收取」的本次响应携带；重放不携带。 */
    activationUrl: string | null;
    /** completed 且链接仍在库中待收取（调用 collect-delivery 一次性取回）。 */
    pendingCollect: boolean;
    note: string;
  };
}>;

type InviteDeps = Readonly<{
  /** 懒解析的 IdP 客户端来源：每次 provision 调用解析现行 token（密封仓优先于
      env 兜底），轮换无需重启即对下一次调用生效；解析为 null 表示未配置。 */
  idp: IdpAdminClientSource;
  workspaceCreator: WorkspaceCreator;
  products: Pick<ProductEntitlementService, "assign">;
  allowance: Pick<AiAllowanceService, "grant" | "balance">;
  store: InviteAuditStore;
  /** 缺省产品版本：pro_trial_configuration:current 批准的产品修订；无配置时返回 null。 */
  defaultProductRevision: () => Promise<string | null>;
  /**
   * 同步响应窗口：任务在该窗口内完成则随 POST 一并返回（旧契约）；
   * 超时返回 processing，任务继续在后台执行，调用方轮询 GET。
   * 默认 60s（低于 broker 105s 与边缘代理 120s 的硬上限）。
   */
  syncWindowMs?: number;
  /**
   * processing 僵死阈值：行在该阈值前仍未完结视为上轮执行已断，允许同参重发续跑
   * （execute 各步幂等）。默认 240s（= 同步窗 + 上游最坏耗时的余量）。
   */
  staleProcessingMs?: number;
}>;

function recordIdFor(idempotencyKey: string): string {
  return `ops_invitation:${stableSha256(idempotencyKey).slice(0, 40)}`;
}

function requestDigest(input: CreateOpsInvitation): string {
  return stableSha256(JSON.stringify({
    email: input.email.trim().toLowerCase(),
    displayName: input.displayName,
    workspaceSlug: input.workspaceSlug,
    workspaceName: input.workspaceName ?? null,
    planKey: input.planKey,
    productPlanRevisionId: input.productPlanRevisionId ?? null,
    aiAllowance: input.aiAllowance,
    reason: input.reason,
  }));
}

const TIMED = "timed" as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function replayResult(row: InviteAuditRow): InviteResult {
  const o = row.outcome;
  const pendingCollect = row.status === "completed" && row.activationUrlPending;
  const note = row.status === "processing"
    ? "开通仍在进行：轮询本端点；完成后经 collect-delivery 一次性收取激活链接"
    : pendingCollect
      ? "重放返回既有结果；激活链接尚未收取，调用 collect-delivery 一次性获取"
      : row.status === "completed"
        ? "重放返回既有结果；激活链接已收取或本未签发"
        : "重放返回既有失败结果；换用新幂等键可重试";
  return {
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    replayed: true,
    user: o ? { id: o.idpUserId, email: row.email, status: o.idpUserStatus, outcome: o.userOutcome } : null,
    workspace: o ? { slug: row.workspaceSlug, dbName: o.workspaceDb, outcome: o.workspaceOutcome } : null,
    entitlement: o
      ? { planKey: row.planKey, productPlanRevisionId: o.productRevision, billingAccountKey: `personal:${o.idpUserId}` }
      : null,
    aiAllowance: o?.aiAllowance ?? null,
    delivery: {
      channel: o?.deliveryChannel ?? "none",
      activationUrl: null,
      pendingCollect,
      note,
    },
  };
}

export class InviteService {
  private readonly syncWindowMs: number;
  private readonly staleProcessingMs: number;

  constructor(private readonly deps: InviteDeps) {
    this.syncWindowMs = deps.syncWindowMs ?? 60_000;
    this.staleProcessingMs = deps.staleProcessingMs ?? 240_000;
  }

  async provision(actor: InviteActor, input: CreateOpsInvitation): Promise<InviteResult> {
    const idp = await this.deps.idp();
    if (!idp) {
      throw new InviteError("invite-idp-not-configured", "IdP provision token 未配置（密封仓与 IDP_PROVISION_TOKEN 兜底均为空），无法代办开通");
    }
    const expiresAt = Date.parse(input.aiAllowance.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new InviteError("invite-allowance-expiry-invalid", "AI 额度有效期必须是将来时间");
    }

    const digest = requestDigest(input);
    const recordId = recordIdFor(input.idempotencyKey);
    const workspaceName = input.workspaceName ?? input.displayName;

    const claim = await this.deps.store.claim({
      recordId,
      idempotencyKey: input.idempotencyKey,
      operatorSubject: actor.subject,
      authorizedCapability: "subscription.manage",
      email: input.email.trim().toLowerCase(),
      displayName: input.displayName,
      workspaceSlug: input.workspaceSlug,
      workspaceName,
      planKey: input.planKey,
      reason: input.reason,
      requestDigest: digest,
    });
    if (claim.kind === "existing") {
      const row = claim.row;
      if (row.requestDigest !== digest) {
        throw new InviteError("invite-conflict", "幂等键已用于其他请求");
      }
      if (row.status === "processing") {
        const startedAt = row.processingSince ?? row.createdAt;
        const staleBefore = new Date(Date.now() - this.staleProcessingMs);
        const stale = !startedAt || Date.parse(startedAt) < staleBefore.getTime();
        // 仍在执行：直接回 processing 供轮询（旧契约的 invite-in-progress 409 改为可轮询 200）。
        if (!stale) return replayResult(row);
        // 僵死行（上轮请求被断连杀死）：CAS 抢续跑权，失败者只读不回写。
        const resumed = await this.deps.store.markProcessing(row.id, staleBefore);
        if (!resumed) return replayResult(row);
        return this.runWithWindow(actor, input, row.id, workspaceName, expiresAt, idp, true);
      }
      return replayResult(row);
    }

    return this.runWithWindow(actor, input, recordId, workspaceName, expiresAt, idp, false);
  }

  /**
   * 竞速窗：execute 全链路为幂等步骤，可安全地在「调用方断连后继续跑」。
   * 窗口内完成 → 同步返回结果（旧契约）；超时 → 返回 processing，任务不脱管。
   * 后台分支的错误只落库（status=failed），不再抛给已断开的响应。
   */
  private async runWithWindow(
    actor: InviteActor,
    input: CreateOpsInvitation,
    recordId: string,
    workspaceName: string,
    expiresAtMs: number,
    idp: HttpIdpAdminClient,
    replayed: boolean,
  ): Promise<InviteResult> {
    const task = this.execute(actor, input, recordId, workspaceName, expiresAtMs, idp)
      .catch(async (error: unknown) => {
        const code = error instanceof InviteError ? error.code
          : error instanceof IdpAdminError ? error.code
            : "invite-internal-error";
        const message = error instanceof Error ? error.message : String(error);
        await this.deps.store.fail(recordId, code, message).catch(() => undefined);
        throw error instanceof InviteError || error instanceof IdpAdminError
          ? new InviteError(code, message)
          : error;
      });
    const raced = await Promise.race([task, sleep(this.syncWindowMs).then(() => TIMED)]);
    if (raced === TIMED) {
      task.catch(() => undefined); // 后台分支的拒绝已被 catch 内落库，这里只抑制 unhandled
      return {
        idempotencyKey: input.idempotencyKey,
        status: "processing",
        replayed,
        user: null,
        workspace: null,
        entitlement: null,
        aiAllowance: null,
        delivery: {
          channel: "none",
          activationUrl: null,
          pendingCollect: false,
          note: "开通仍在进行：轮询 GET /api/ops/invitations/:key；完成后经 collect-delivery 一次性收取激活链接",
        },
      };
    }
    // 同步窗内完成且携带激活链接：标记为已收取，collect-delivery 不再重复下发。
    if (raced.delivery.activationUrl) {
      await this.deps.store.collectActivationUrl(recordId).catch(() => undefined);
    }
    return replayed ? { ...raced, replayed: true } : raced;
  }

  private async execute(
    actor: InviteActor,
    input: CreateOpsInvitation,
    recordId: string,
    workspaceName: string,
    expiresAtMs: number,
    idp: HttpIdpAdminClient,
  ): Promise<InviteResult> {
    // 1) IdP：建用户或幂等复用；仅新建返回一次性 activation_url。
    const ensured: EnsureUserResult = await idp.ensureUser({
      email: input.email,
      displayName: input.displayName,
    });
    const user = ensured.user;
    // 一次性激活链接：拿到就先落行——此后任务被断连/超时打断，续跑或
    // collect-delivery 仍能救回（否则链接随请求死亡永久丢失）。
    let activationUrl = ensured.activationUrl;
    if (activationUrl) {
      await this.deps.store.saveActivationUrl(recordId, activationUrl).catch(() => undefined);
    } else {
      // 续跑/复用：IdP 不重复签发，读回上环已签发暂存的链接。
      activationUrl = await this.deps.store.storedActivationUrl(recordId).catch(() => null);
    }

    // 2) workspace bootstrap：manual 商业套餐分配（非售假——不产生付费事实），
    //    subjectToken 缺省 → 跳过 scope 换发，用户激活后自行登录进入。
    let workspaceDb: string;
    let workspaceOutcome: "created" | "reused";
    const created = await this.deps.workspaceCreator.createWorkspace({
      subject: user.id,
      email: user.email,
      name: workspaceName,
      slug: input.workspaceSlug,
      resourceSource: { planKey: input.planKey, sourceKind: "manual" },
    });
    if (created.kind === "created") {
      workspaceDb = created.dbName;
      workspaceOutcome = "created";
    } else if (created.kind === "slug-conflict") {
      const existing = await this.deps.store.workspaceBySlug(input.workspaceSlug);
      if (existing && existing.ownerSubject === user.id && existing.dbName) {
        workspaceDb = existing.dbName;
        workspaceOutcome = "reused";
      } else {
        throw new InviteError("invite-slug-taken", `workspace slug ${input.workspaceSlug} 已被其他主体占用`);
      }
    } else if (created.kind === "scope-update-failed") {
      workspaceDb = created.dbName;
      workspaceOutcome = "reused";
    } else {
      throw new InviteError(`invite-provisioning-${created.code}`, `workspace 供应失败：${created.message}`);
    }

    // 3) 内容权益：manual 订阅 + 绑定产品版本（subscription.manage，自带幂等与审计）。
    const productRevisionId = input.productPlanRevisionId ?? await this.deps.defaultProductRevision();
    if (!productRevisionId) {
      throw new InviteError("invite-product-revision-missing", "未指定产品版本且无可用默认（pro_trial_configuration）");
    }
    await this.deps.products.assign(
      { subject: actor.subject, capabilities: actor.capabilities },
      {
        workspaceSlug: input.workspaceSlug,
        billingAccountKey: `personal:${user.id}`,
        productPlanRevisionId: productRevisionId,
        reason: input.reason,
        idempotencyKey: `${input.idempotencyKey}:assign`,
      },
    );

    // 4) AI 额度桶：period_key=invite:<key> 查重防重放重复授额（中途失败重试场景）。
    const periodKey = `invite:${input.idempotencyKey}`;
    const balance = await this.deps.allowance.balance(workspaceDb);
    const existingBucket = balance.buckets.find((b) => b.period_key === periodKey);
    let bucketId: string | null = existingBucket ? String(existingBucket.id) : null;
    if (!existingBucket) {
      const granted = await this.deps.allowance.grant({
        db: workspaceDb,
        kind: "compensation",
        amount: input.aiAllowance.amount,
        label: input.aiAllowance.label,
        periodKey,
        effectiveFrom: new Date(),
        expiresAt: new Date(expiresAtMs),
        source: "ops-invite",
        operatorSubject: actor.subject,
      });
      bucketId = granted.bucket ? String(granted.bucket) : null;
    }

    const outcome: InviteOutcome = {
      idpUserId: user.id,
      idpUserStatus: user.status,
      userOutcome: ensured.created ? "created" : "reused",
      workspaceDb,
      workspaceOutcome,
      productRevision: productRevisionId,
      contentAssigned: true,
      aiAllowance: {
        kind: "compensation",
        amount: input.aiAllowance.amount,
        periodKey,
        expiresAt: new Date(expiresAtMs).toISOString(),
        bucket: bucketId,
      },
      deliveryChannel: activationUrl ? "activation_url" : "none",
      activationUrlIssued: activationUrl !== null,
    };
    await this.deps.store.complete(recordId, outcome);

    return {
      idempotencyKey: input.idempotencyKey,
      status: "completed",
      replayed: false,
      user: { id: user.id, email: user.email, status: user.status, outcome: outcome.userOutcome },
      workspace: { slug: input.workspaceSlug, dbName: workspaceDb, outcome: workspaceOutcome },
      entitlement: {
        planKey: input.planKey,
        productPlanRevisionId: productRevisionId,
        billingAccountKey: `personal:${user.id}`,
      },
      aiAllowance: outcome.aiAllowance,
      delivery: {
        channel: activationUrl ? "activation_url" : "none",
        activationUrl,
        pendingCollect: false,
        note: activationUrl
          ? "激活链接已随本响应一次性下发（转交用户激活；不再次返回）"
          : "用户已存在（幂等复用），不重复签发激活链接",
      },
    };
  }

  async get(idempotencyKey: string): Promise<InviteResult | null> {
    const row = await this.deps.store.byKey(idempotencyKey);
    return row ? replayResult(row) : null;
  }

  /**
   * 一次性收取激活链接：仅 completed 且尚未收取才返回 URL，随即从行中清除。
   * processing → 返回空供继续轮询；failed → 附错误信息；重复收取 → 空 URL。
   */
  async collect(idempotencyKey: string): Promise<InviteCollect | null> {
    const row = await this.deps.store.byKey(idempotencyKey);
    if (!row) return null;
    const res = await this.deps.store.collectActivationUrl(row.id);
    return {
      idempotencyKey,
      status: row.status,
      activationUrl: res.activationUrl,
      deliveredAt: res.deliveredAt,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
    };
  }
}
