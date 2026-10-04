import type { CreateOpsInvitation } from "@surreal-ck/shared";
import { stableSha256 } from "../quota/canonical";
import type { PlatformOperatorCapability } from "@surreal-ck/shared/native-quota";
import type { WorkspaceCreator } from "../workspaces/create-workspace";
import type { ProductEntitlementService } from "../product-entitlement/service";
import type { AiAllowanceService } from "../ai-allowance/service";
import type { EnsureUserResult, HttpIdpAdminClient } from "./idp-admin-client";
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
    /** 一次性激活链接：仅「新用户 + 本次调用」返回；审计与重放均不携带。 */
    activationUrl: string | null;
    note: string;
  };
}>;

type InviteDeps = Readonly<{
  idp: HttpIdpAdminClient | null;
  workspaceCreator: WorkspaceCreator;
  products: Pick<ProductEntitlementService, "assign">;
  allowance: Pick<AiAllowanceService, "grant" | "balance">;
  store: InviteAuditStore;
  /** 缺省产品版本：pro_trial_configuration:current 批准的产品修订；无配置时返回 null。 */
  defaultProductRevision: () => Promise<string | null>;
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

function replayResult(row: InviteAuditRow): InviteResult {
  const o = row.outcome;
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
      note: "重放返回既有结果；激活链接仅在首次调用时下发一次",
    },
  };
}

export class InviteService {
  constructor(private readonly deps: InviteDeps) {}

  async provision(actor: InviteActor, input: CreateOpsInvitation): Promise<InviteResult> {
    if (!this.deps.idp) {
      throw new InviteError("invite-idp-not-configured", "IdP provision token 未配置（IDP_PROVISION_TOKEN），无法代办开通");
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
        throw new InviteError("invite-in-progress", "同一幂等键的开通正在处理中，请稍后查询");
      }
      return replayResult(row);
    }

    try {
      return await this.execute(actor, input, recordId, workspaceName, expiresAt);
    } catch (error) {
      const code = error instanceof InviteError ? error.code
        : error instanceof IdpAdminError ? error.code
          : "invite-internal-error";
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.store.fail(recordId, code, message).catch(() => undefined);
      throw error instanceof InviteError || error instanceof IdpAdminError
        ? new InviteError(code, message)
        : error;
    }
  }

  private async execute(
    actor: InviteActor,
    input: CreateOpsInvitation,
    recordId: string,
    workspaceName: string,
    expiresAtMs: number,
  ): Promise<InviteResult> {
    // 1) IdP：建用户或幂等复用；仅新建返回一次性 activation_url。
    const ensured: EnsureUserResult = await this.deps.idp!.ensureUser({
      email: input.email,
      displayName: input.displayName,
    });
    const user = ensured.user;

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
      deliveryChannel: ensured.activationUrl ? "activation_url" : "none",
      activationUrlIssued: ensured.activationUrl !== null,
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
        channel: ensured.activationUrl ? "activation_url" : "none",
        activationUrl: ensured.activationUrl,
        note: ensured.created
          ? "IdP 未配置邀请邮件通道，请将 activation_url 经老板/邀请人转交用户激活"
          : "用户已存在（幂等复用），不重复签发激活链接",
      },
    };
  }

  async get(idempotencyKey: string): Promise<InviteResult | null> {
    const row = await this.deps.store.byKey(idempotencyKey);
    return row ? replayResult(row) : null;
  }
}
