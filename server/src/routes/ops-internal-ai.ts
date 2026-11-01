import { runtimeEndpoint } from '../internal-ai/runtime-endpoint';
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { isMagpieFreeStopReason, MAGPIE_FREE_QUOTA_WINDOW_CONTRACT_VERSION, MAGPIE_REMOTE_WINDOW_CONTRACT_VERSION, MAGPIE_WINDOW_CONTRACT_VERSION, magpieFreeQuotaBasisCreateSchema, magpieFreeQuotaRemoteWindowCreateSchema, magpieRemoteWindowCreateSchema, magpieWindowBindSchema, magpieWindowCreateSchema, type MagpieFreeQuotaBasis, type MagpieWindowView } from "@surreal-ck/shared";
import type { AppBindings } from "../hono-types";
import { requirePlatformOperator } from "../ops/operator-auth";
import { MEASUREMENT_CYCLE } from "../internal-ai/store";
import type { InternalAiGate } from "../internal-ai/gate";
import { WindowDenied, type WindowRow } from "../internal-ai/window";
import { InternalAiRegistration, normalizeReason, PRICE_REQUIRED_EVIDENCE } from "../internal-ai/registration";
import { verifyCompanyProof } from "../internal-ai/company-proof";
import { endpointHost, TARIFFS } from "../internal-ai/pricing";
import { aggregateAssessments, assessAttempt, type AssessedAttempt, type AssessmentContext } from "../internal-ai/assessment";
import { runtimeIdentity } from "../../ai/mastra/agents/model-config";
import { HttpError } from "../http-error";
function dependencyVersion(): string | null {
  try { const entry = createRequire(import.meta.url).resolve("@mastra/core"); const parsed: unknown = JSON.parse(readFileSync(join(dirname(entry), "../package.json"), "utf8")); return parsed && typeof parsed === "object" && "version" in parsed && typeof parsed.version === "string" ? parsed.version : null; } catch { return null; }
}
const label = (value: string | undefined) => value && /^[a-zA-Z0-9_.\/-]{1,100}$/.test(value) ? value : null;
const hostOf = (endpoint: string): string | null => { try { return new URL(endpoint).host; } catch { return null; } };
const isoOf = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
/** 固定投影：不含 operator subject、请求/响应正文或任何秘密。v1 行的 v2 分层字段为 null。 */
function windowView(row: WindowRow): MagpieWindowView {
  return {
    // 只暴露裸 UUID：路由 :id 校验不接受 record 表名前缀/⟨⟩，create 响应必须能直接用于 GET/bind。
    id: String(row.id.id), activity: row.activity, status: row.status, revision: row.revision,
    approvalDigest: row.approval_digest, approvalTask: row.approval_task, accountRef: row.account_ref,
    evidenceExpiresAt: row.evidence_expires_at, envelope: row.envelope ?? null, attempts: row.attempts, attemptLimit: row.attempt_limit,
    reserved: row.reserved, spent: row.spent,
    contractVersion: row.contract_version ?? MAGPIE_WINDOW_CONTRACT_VERSION,
    evidenceVersion: row.evidence_version ?? null,
    observation: row.observation_captured_at == null ? null : {
      capturedAt: row.observation_captured_at, digest: row.observation_digest ?? null,
      routingConfigurationVerified: row.routing_configuration_verified ?? null,
    },
    routeGaps: row.route_gaps ?? null,
    route: {
      revision: row.route_revision ?? null, digest: row.route_digest ?? null, requestedModel: row.requested_model,
      servedModel: row.served_model, endpointHost: hostOf(row.endpoint), accountBinding: row.account_binding,
      priceRevision: row.price_revision, priceBasis: row.price_basis,
      amortizedNanoUsd: row.amortized_nano_usd ?? null, marginalNanoUsd: row.marginal_nano_usd ?? null,
      sampledAt: row.sampled_at, expiresAt: row.route_expires_at ?? null, provider: row.route_provider ?? null,
    },
    expiry: row.local_freshness_expires_at == null && row.expiry_basis == null ? null : {
      basis: row.expiry_basis ?? null, localFreshnessExpiresAt: row.local_freshness_expires_at ?? null,
      sourceExpiresAt: row.source_expires_at ?? [],
    },
    priceEvidence: row.pricing_evidence_revision == null && row.pricing_reviewed == null ? null : {
      evidenceRevision: row.pricing_evidence_revision ?? null, reviewed: row.pricing_reviewed ?? null,
    },
    capacity: {
      database: row.capacity_database, entityTables: row.capacity_tables, fieldsPerTable: row.capacity_fields,
      recordsPerTable: row.capacity_records, ttlSeconds: row.capacity_ttl_seconds,
      destructive: row.capacity_destructive, source: row.capacity_source,
    },
    freeQuota: row.contract_version === MAGPIE_FREE_QUOTA_WINDOW_CONTRACT_VERSION && row.free_evidence_hash ? { basisHash: row.free_evidence_hash } : null,
    stop: isMagpieFreeStopReason(row.stop_reason) ? { reason: row.stop_reason, stoppedAt: isoOf(row.stopped_at) } : null,
    createdAt: isoOf(row.created_at), boundAt: isoOf(row.bound_at),
  };
}
function windowHttpError(e: unknown): HttpError {
  if (e instanceof WindowDenied) {
    const status = ["magpie-window-activity-unknown", "magpie-window-unknown", "magpie-window-free-basis-unknown"].includes(e.code) ? 404
      : ["magpie-window-idempotency-conflict", "magpie-window-approval-consumed", "magpie-window-already-bound", "magpie-window-revision-conflict", "magpie-window-free-quota-stopped"].includes(e.code) ? 409
      : 422;
    return new HttpError(status, e.code, e.message);
  }
  return new HttpError(503, "magpie-window-store-unavailable", "窗口存储不可用");
}
export function createOpsInternalAiRoutes(input: { gate: InternalAiGate; registration?: InternalAiRegistration; runtime: { provider?: string; model?: string; endpoint?: string; jevModel?: string; jevEnabled?: boolean }; requireOperator?: MiddlewareHandler<AppBindings> }) {
  const registration = input.registration ?? new InternalAiRegistration(async () => { throw new Error("registration unavailable"); });
  const auth = input.requireOperator ?? requirePlatformOperator("subscription.manage");
  const json = async (c: { req: { json(): Promise<unknown> } }) => { try { return await c.req.json(); } catch { throw new HttpError(400, "internal-ai-body-invalid", "请求体不是合法 JSON"); } };
  const reasonOf = (payload: unknown) => normalizeReason((payload as { reason?: unknown } | null)?.reason);
  return new Hono<AppBindings>()
    .get("/api/ops/internal-ai/runtime", auth, c => c.json({
      provider: label(input.runtime.provider), model: label(input.runtime.model), endpointHost: runtimeEndpoint(input.runtime.endpoint)?.host ?? null, endpointBinding: runtimeEndpoint(input.runtime.endpoint),
      jevEnabled: input.runtime.jevEnabled ?? false, jevModel: label(input.runtime.jevModel), jevEndpointHost: "api.typesafe.ai", mastraVersion: dependencyVersion(),
      priceCertificates: TARIFFS, defaultEnabled: false, balance: { status: "unavailable", reason: "no approved account-bound balance evidence or supported read-only supplier balance API; API key presence is not evidence" },
      implicitRetries: 0, embedding: "forbidden-in-internal-activity", currency: "USD", moneyUnit: "nanoUSD", fx: { rate: 1, currency: "USD", nonUSD: "unsupported" },
    }))
    .get("/api/ops/internal-ai/activities/:id", auth, async c => {
      const id = c.req.param("id");
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new HttpError(400, "internal-ai-id-invalid", "活动标识无效");
      const activity = await input.gate.store.activity(id);
      if (!activity) throw new HttpError(404, "internal-ai-unconfigured", "内部活动尚未受审配置，禁止付费调用");
      const after = Number(c.req.query("after") ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, "internal-ai-cursor-invalid", "游标无效");
      // FV06 可选只读成本评价：?assessment=1 才追加投影与聚合；未知取值拒绝，避免悄悄换语义。
      const assessmentParam = c.req.query("assessment");
      if (assessmentParam !== undefined && assessmentParam !== "1") throw new HttpError(400, "internal-ai-assessment-invalid", "成本评价仅支持 assessment=1");
      const successfulTasksParam = c.req.query("successfulTasks");
      const successfulTasks = successfulTasksParam === undefined ? undefined : Number(successfulTasksParam);
      if (successfulTasks !== undefined && (!Number.isSafeInteger(successfulTasks) || successfulTasks < 0)) throw new HttpError(400, "internal-ai-assessment-invalid", "successfulTasks 必须是非负整数");
      const attempts = await input.gate.store.page(id, after);
      const target = await input.gate.store.target();
      const measurementCycle = await input.gate.store.measurementCycle();
      const bound = await input.gate.store.boundWindow(id);
      // 评价上下文：调用时刻的授权 revision 证据窗口 + 固定测量周期，全部只读。
      let assessments: Map<string, ReturnType<typeof assessAttempt>> | null = null;
      let aggregate: ReturnType<typeof aggregateAssessments> | null = null;
      if (assessmentParam === "1") {
        const ctx: AssessmentContext = {
          cycle: measurementCycle ? { id: MEASUREMENT_CYCLE, ...measurementCycle } : null,
          revisions: (await input.gate.store.revisionEvidence(id)).map(r => ({
            revision: r.revision, state: r.state, createdAt: r.created_at, documentHash: r.document_hash,
            evidenceKind: r.evidence_kind, accountPlanType: r.account_plan_type, accountRef: r.account_ref,
            sampledAt: r.balance_sampled_at, expiresAt: r.evidence_expires_at,
            endpoint: r.endpoint, model: r.model, priceRevision: r.price_revision,
          })),
        };
        assessments = new Map(attempts.map(a => [String(a.id), assessAttempt(a, ctx)]));
        const assessed: AssessedAttempt[] = attempts.map(a => ({ id: String(a.id), sequence: a.sequence, runHash: a.run_hash, state: a.state, costAssessment: assessments!.get(String(a.id))! }));
        aggregate = aggregateAssessments(assessed, { successfulTasks });
      }
      const nextAfter = attempts.length === 50 ? attempts.at(-1)?.sequence ?? null : null;
      // 固定字段投影，绝不序列化config任意对象/请求/响应/工具载荷。
      return c.json({ measurementCycle: measurementCycle ? { id: MEASUREMENT_CYCLE, ...measurementCycle } : null, target: { ...target, cumulativeAttempts: target.attempts + (measurementCycle?.attempts ?? 0), totalLimit: 1000000000, attemptLimit: 30, remaining: Math.max(0, 1000000000 - target.spent - target.reserved) }, activity: id, enabled: activity.enabled, approvalRevision: activity.approval_revision ?? null,
        window: bound ? windowView(bound) : null, activityRevision: activity.window_revision ?? 0,
        limits: { total: activity.total_limit, perAttempt: activity.per_attempt_limit, attempts: activity.attempt_limit },
        spent: activity.spent, reserved: activity.reserved, attemptsUsed: activity.attempts, cumulativeAttemptsUsed: activity.attempts + (measurementCycle?.activity === id ? measurementCycle.attempts : 0),
        remaining: Math.max(0, activity.total_limit - activity.spent - activity.reserved), moneyUnit: "nanoUSD", currency: "USD",
        priceRevisions: activity.price_revisions,
        evidenceKind: activity.evidence_kind ?? null,
        balance: { status: activity.balance_evidence_hash ? "reviewed-evidence" : "unavailable", amount: activity.balance_nano_usd ?? null, currency: activity.balance_currency ?? null, source: activity.balance_source && /^(reviewed-document|token-plan):[0-9a-f]{64}$/.test(activity.balance_source) ? activity.balance_source : null, evidenceHash: activity.balance_evidence_hash ?? null, sampledAt: activity.balance_sampled_at ?? null, expiresAt: activity.evidence_expires_at ?? null, autoTopupDisabled: activity.auto_topup_disabled, serviceApproved: activity.service_approved },
        quota: activity.evidence_kind === "reviewed-token-plan" ? { planName: activity.plan_name ?? null, planSourceUrl: activity.plan_source_url ?? null, accountPlanType: activity.account_plan_type ?? null, unit: activity.quota_unit ?? null, amount: activity.quota_amount ?? null, windowSeconds: activity.quota_window_seconds ?? null, remaining: activity.quota_remaining ?? null, noPaymentInstrument: activity.no_payment_instrument ?? null } : null,
        attempts: attempts.map(a => ({ id: String(a.id), sequence: a.sequence, measurementCycle: a.measurement_cycle ?? null, window: a.window ? String(a.window) : null, retryIndex: a.retry_index, runHash: a.run_hash, keyHash: a.key_hash, logicalHash: a.logical_hash, stage: a.stage, state: a.state, provider: a.provider, model: a.model, requestedModel: a.requested_model ?? null, actualModel: a.actual_model ?? null, servedModel: a.served_model ?? a.actual_model ?? null, routeRevision: a.route_revision ?? null, routeDigest: a.route_digest ?? null, accountBinding: a.account_binding ?? null, requestId: a.request_id ?? null, usage: a.usage ?? null, usageRaw: a.usage_raw ?? null, usageSource: a.usage_source, priceRevision: a.price_revision, priceBasis: a.price_basis ?? null, currency: a.currency, reserved: a.reserved, cost: a.cost ?? null, costStatus: a.cost_status ?? null, amortizedCost: a.amortized_cost_nano_usd ?? null, marginalCost: a.marginal_cost_nano_usd ?? null, failureClass: a.failure_class ?? null, routeDrift: a.route_drift === true, startedAt: a.started_at, endedAt: a.ended_at, ...(assessments ? { costAssessment: assessments.get(String(a.id)) } : {}) })),
        nextAfter,
        ...(aggregate ? { costAssessment: { ...aggregate, window: { after, pageSize: attempts.length, complete: nextAfter === null }, computedAt: new Date().toISOString() } } : {}),
      });
    })
    /** 公司运营程序投递可信证明：验签后先建 disabled，绝不因运营自填而放行。 */
    .post("/api/ops/internal-ai/company-proof", auth, async c => {
      const payload = await json(c);
      const envelope = z.object({ proof: z.string().min(1).max(32000), reason: z.string().min(1).max(500).optional() }).strict().safeParse(payload);
      if (!envelope.success) throw new HttpError(400, "company-proof-body-invalid", "证明信封不合法");
      const claims = verifyCompanyProof(envelope.data.proof, Date.now());
      const reason = envelope.data.reason ?? `公司证明投递 ${claims.requestTask}`;
      const summary = await registration.register({ claims, operator: c.var.platformOperator.subject, reason });
      return c.json(summary, 201);
    })
    /**
     * 提交受审余额证据文档：正文绝不落库，只校验 sha256 必须等于公司证明签发的 documentHash，
     * 再按严格 USD-only schema 记录脱敏字段。运营自填的 true / USD 1 因此无效。
     */
    .post("/api/ops/internal-ai/activities/:id/evidence", auth, async c => {
      const id = c.req.param("id");
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new HttpError(400, "internal-ai-id-invalid", "活动标识无效");
      const payload = await json(c);
      const parsed = z.object({
        revision: z.number().int().positive(),
        document: z.string().min(1).max(256 * 1024),
        reason: z.string().min(1).max(500),
      }).strict().safeParse(payload);
      if (!parsed.success) throw new HttpError(400, "internal-ai-document-invalid", "证据文档信封不合法");
      const summary = await registration.submitEvidence({ activity: id, revision: parsed.data.revision, document: parsed.data.document, operator: c.var.platformOperator.subject, reason: reasonOf(payload) });
      return c.json(summary, 201);
    })
    /** 显式启用：证据缺口逐条返回，fail-closed。 */
    .post("/api/ops/internal-ai/activities/:id/enable", auth, async c => {
      const id = c.req.param("id");
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new HttpError(400, "internal-ai-id-invalid", "活动标识无效");
      const payload = await json(c);
      const parsed = z.object({ revision: z.number().int().positive(), reason: z.string().min(1).max(500), measurementCycle: z.boolean().optional() }).strict().safeParse(payload);
      if (!parsed.success) throw new HttpError(400, "internal-ai-revision-invalid", "必须指定正整数登记版本");
      const summary = await registration.enable({ measurementCycle: parsed.data.measurementCycle, activity: id, revision: parsed.data.revision, operator: c.var.platformOperator.subject, reason: reasonOf(payload), runtime: input.runtime });
      return c.json(summary);
    })
    /** 显式禁用：保留历史与账本。 */
    .post("/api/ops/internal-ai/activities/:id/disable", auth, async c => {
      const id = c.req.param("id");
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new HttpError(400, "internal-ai-id-invalid", "活动标识无效");
      const payload = await json(c);
      const parsed = z.object({ reason: z.string().min(1).max(500) }).strict().safeParse(payload);
      if (!parsed.success) throw new HttpError(400, "internal-ai-body-invalid", "禁用参数不合法");
      return c.json(await registration.disable({ activity: id, operator: c.var.platformOperator.subject, reason: reasonOf(payload) }));
    })
    /** 撤销身份绑定：持久标记，不删行、不重置账本。 */
    .post("/api/ops/internal-ai/identities/revoke", auth, async c => {
      const payload = await json(c);
      const parsed = z.object({ alias: z.enum(["LCA04_REMOVABLE", "LCA04_MEMBER"]), activity: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), reason: z.string().min(1).max(500) }).strict().safeParse(payload);
      if (!parsed.success) throw new HttpError(400, "internal-ai-alias-invalid", "仅允许公司测试别名与活动标识");
      return c.json(await registration.revokeIdentity({ alias: parsed.data.alias, activity: parsed.data.activity, operator: c.var.platformOperator.subject, reason: reasonOf(payload) }));
    })
    /** 不可变审计 revision 读回：旧证据不可改，更新只新增。 */
    .get("/api/ops/internal-ai/activities/:id/revisions", auth, async c => {
      const id = c.req.param("id");
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new HttpError(400, "internal-ai-id-invalid", "活动标识无效");
      return c.json({ activity: id, revisions: await registration.preview(id) });
    })
    /**
     * 新受控授权窗口：输入新独立批准 digest/证据期/源预算 + 冻结路由/容量声明。
     * 产品侧拒绝旧周期/旧批准/旧 proof、过期证据、超出剩余次数与容量 scope；
     * 幂等键重复且载荷一致返回既有窗口，批准摘要重复一律 409。
     */
    .post("/api/ops/internal-ai/windows", auth, async c => {
      const payload = await json(c);
      const parsed = magpieWindowCreateSchema.safeParse(payload);
      if (!parsed.success) throw new HttpError(400, "magpie-window-body-invalid", "窗口创建参数不合法");
      try {
        const result = await input.gate.store.createWindow(parsed.data, c.var.platformOperator.subject);
        return c.json({ contract: MAGPIE_WINDOW_CONTRACT_VERSION, idempotentReplay: result.idempotentReplay, window: windowView(result.window), activityRevision: await input.gate.store.windowRevision(parsed.data.activity) }, result.idempotentReplay ? 200 : 201);
      } catch (e) { throw windowHttpError(e); }
    })
    /** B 档包络只读核对：已用/已承诺/剩余次数与 USD，供 qa 在调用前确认。 */
    .get("/api/ops/internal-ai/envelopes/current", auth, async c => {
      const envelope = await input.gate.store.envelopeSummary();
      if (!envelope) throw new HttpError(404, "magpie-envelope-unknown", "B 档包络账本不存在或与批准摘要不一致");
      return c.json({ contract: MAGPIE_WINDOW_CONTRACT_VERSION, envelope, moneyUnit: "nanoUSD", currency: "USD", expired: Date.now() >= Date.parse(envelope.expiresAt) });
    })
    .get("/api/ops/internal-ai/windows/:id", auth, async c => {
      const id = c.req.param("id");
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new HttpError(400, "magpie-window-id-invalid", "窗口标识无效");
      const row = await input.gate.store.window(id);
      if (!row) throw new HttpError(404, "magpie-window-unknown", "窗口不存在");
      return c.json({ contract: row.contract_version ?? MAGPIE_WINDOW_CONTRACT_VERSION, window: windowView(row) });
    })
    /** 绑定窗口到活动：activity window_revision CAS，已绑同一窗口时幂等返回。 */
    .post("/api/ops/internal-ai/windows/:id/bind", auth, async c => {
      const id = c.req.param("id");
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new HttpError(400, "magpie-window-id-invalid", "窗口标识无效");
      const payload = await json(c);
      const parsed = magpieWindowBindSchema.safeParse(payload);
      if (!parsed.success) throw new HttpError(400, "magpie-window-body-invalid", "窗口绑定参数不合法");
      try {
        const result = await input.gate.store.bindWindow(id, { activity: parsed.data.activity, expectedRevision: parsed.data.expectedRevision }, c.var.platformOperator.subject);
        return c.json({ contract: result.window.contract_version ?? MAGPIE_WINDOW_CONTRACT_VERSION, idempotentReplay: result.idempotentReplay, window: windowView(result.window), activityRevision: result.activityRevision, reason: parsed.data.reason });
      } catch (e) { throw windowHttpError(e); }
    })
    /**
     * 远端窗口创建（magpie-window/v2）：接收公司已批准的 remote-magpie-evidence/1
     * null+gap 证据投影。路由元数据不取自输入——服务端用受控运行配置（env 的
     * provider/model/endpoint，与实际请求路径同源）交叉核对证据来源后冻结；
     * 价格由证据复核状态+已核证书派生，unknown 在请求门禁闭锁。创建/读回/CAS
     * 绑定/请求门禁共用同一窗口行。
     */
    .post("/api/ops/internal-ai/remote-windows", auth, async c => {
      const payload = await json(c);
      const parsed = magpieRemoteWindowCreateSchema.safeParse(payload);
      if (!parsed.success) throw new HttpError(400, "magpie-window-body-invalid", "远端窗口创建参数不合法");
      const runtime = input.runtime.model && input.runtime.endpoint
        ? runtimeIdentity({ provider: input.runtime.provider ?? "", model: input.runtime.model, baseUrl: input.runtime.endpoint })
        : null;
      try {
        const result = await input.gate.store.createRemoteWindow(parsed.data, c.var.platformOperator.subject, runtime);
        return c.json({ contract: MAGPIE_REMOTE_WINDOW_CONTRACT_VERSION, idempotentReplay: result.idempotentReplay, window: windowView(result.window), activityRevision: await input.gate.store.windowRevision(parsed.data.activity) }, result.idempotentReplay ? 200 : 201);
      } catch (e) { throw windowHttpError(e); }
    })
    /**
     * 免费额度依据（magpie-window/v3）：老板决定引用 + 固定路由 + B 包络 + 生效/到期。
     * 记录 id 即规范化内容的 sha256，同内容重放返回既有记录；hash 由服务端计算，不接受客户端自填。
     */
    .post("/api/ops/internal-ai/free-quota-bases", auth, async c => {
      const payload = await json(c);
      const parsed = magpieFreeQuotaBasisCreateSchema.safeParse(payload);
      if (!parsed.success) throw new HttpError(400, "magpie-window-body-invalid", "免费额度依据参数不合法");
      try {
        const result = await input.gate.store.createFreeQuotaBasis(parsed.data, c.var.platformOperator.subject);
        return c.json({ contract: MAGPIE_FREE_QUOTA_WINDOW_CONTRACT_VERSION, idempotentReplay: result.idempotentReplay, hash: result.hash, basis: result.basis }, result.idempotentReplay ? 200 : 201);
      } catch (e) { throw windowHttpError(e); }
    })
    /** 依据读回：服务端按记录内容复算 hash，不一致返回 422 magpie-window-free-basis-invalid。 */
    .get("/api/ops/internal-ai/free-quota-bases/:hash", auth, async c => {
      const hash = c.req.param("hash");
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new HttpError(400, "magpie-window-free-basis-hash-invalid", "依据 hash 必须是 64 位小写十六进制");
      let basis: MagpieFreeQuotaBasis | null;
      try { basis = await input.gate.store.freeQuotaBasis(hash); } catch (e) { throw windowHttpError(e); }
      if (!basis) throw new HttpError(404, "magpie-window-free-basis-unknown", "免费额度依据不存在");
      return c.json({ contract: MAGPIE_FREE_QUOTA_WINDOW_CONTRACT_VERSION, hash, basis });
    })
    /**
     * 免费额度远端窗口（magpie-window/v3）：v2 证据门禁 + 依据门禁，只允许 B 档包络。
     * 价格只由依据派生为 free-evidence；目录 0/0 与 reviewed 状态都不参与价格派生。
     */
    .post("/api/ops/internal-ai/free-quota-remote-windows", auth, async c => {
      const payload = await json(c);
      const parsed = magpieFreeQuotaRemoteWindowCreateSchema.safeParse(payload);
      if (!parsed.success) throw new HttpError(400, "magpie-window-body-invalid", "免费额度远端窗口参数不合法");
      const runtime = input.runtime.model && input.runtime.endpoint
        ? runtimeIdentity({ provider: input.runtime.provider ?? "", model: input.runtime.model, baseUrl: input.runtime.endpoint })
        : null;
      try {
        const result = await input.gate.store.createFreeQuotaRemoteWindow(parsed.data, c.var.platformOperator.subject, runtime);
        return c.json({ contract: MAGPIE_FREE_QUOTA_WINDOW_CONTRACT_VERSION, idempotentReplay: result.idempotentReplay, window: windowView(result.window), activityRevision: await input.gate.store.windowRevision(parsed.data.activity) }, result.idempotentReplay ? 200 : 201);
      } catch (e) { throw windowHttpError(e); }
    })
    /**
     * 固定官方供应商账户资料探测：封闭白名单，只读、脱敏。
     * 未登记官方 balance/plan/usage 能力的供应商明确返回 unsupported 并列所需证据字段，
     * 不探测未知接口、不返回秘密/登录口令、不建账户、不充值、不启用自动充值。
     */
    .get("/api/ops/internal-ai/supplier-probe", auth, c => {
      const rawHost = c.req.query("host");
      const host = rawHost && /^[a-z0-9.-]+$/.test(rawHost) ? rawHost : null;
      if (!host) throw new HttpError(400, "internal-ai-host-invalid", "仅允许已核定的 https 供应商主机");
      // 只允许当前生产连接或已核定价目证书出现过的主机；其余一律拒绝，不做任何探测。
      const allowed = new Set<string>([endpointHost(input.runtime.endpoint), ...TARIFFS.map(t => t.host)].filter((v): v is string => Boolean(v)));
      if (!allowed.has(host)) throw new HttpError(403, "internal-ai-host-unknown", "该主机不在已核定供应商集合内");
      const capability = SUPPLIER_PROBES.find(p => p.host === host);
      if (!capability) return c.json({ host, status: "unsupported", capabilities: [], requiredEvidence: PRICE_REQUIRED_EVIDENCE, reason: "no reviewed official read-only supplier account capability is registered for this host" });
      return c.json({ host, provider: capability.provider, status: "unsupported", capabilities: capability.capabilities, requiredEvidence: PRICE_REQUIRED_EVIDENCE, reason: capability.reason });
    });
}

/**
 * 已登记的官方只读账户资料能力。**空数组即明确 unsupported**：新增能力必须是一次代码评审过的
 * 固定 method/path/响应schema/脱敏投影，禁止运行期配置或扫描式探测。
 */
export const SUPPLIER_PROBES: readonly { provider: string; host: string; capabilities: readonly string[]; reason: string }[] = [
  { provider: "sensenova", host: "token.sensenova.cn", capabilities: [], reason: "SenseNova 当前没有已核定的官方只读 balance/plan/usage 接口；Token Plan 配额与零费率只能经 reviewed-token-plan 受审文档登记，不得凭 OpenAI-compatible 协议、积分换算或 .ai 文档推断 .cn 计价" },
];
