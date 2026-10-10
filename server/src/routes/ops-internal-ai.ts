import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { AppBindings } from "../hono-types";
import { requirePlatformOperator } from "../ops/operator-auth";
import type { InternalAiGate } from "../internal-ai/gate";
import { InternalAiRegistration, normalizeReason, PRICE_REQUIRED_EVIDENCE } from "../internal-ai/registration";
import { verifyCompanyProof } from "../internal-ai/company-proof";
import { endpointHost, TARIFFS } from "../internal-ai/pricing";
import { HttpError } from "../http-error";
function dependencyVersion(): string | null {
  try { const entry = createRequire(import.meta.url).resolve("@mastra/core"); const parsed: unknown = JSON.parse(readFileSync(join(dirname(entry), "../package.json"), "utf8")); return parsed && typeof parsed === "object" && "version" in parsed && typeof parsed.version === "string" ? parsed.version : null; } catch { return null; }
}
const label = (value: string | undefined) => value && /^[a-zA-Z0-9_.\/-]{1,100}$/.test(value) ? value : null;
export function createOpsInternalAiRoutes(input: { gate: InternalAiGate; registration?: InternalAiRegistration; runtime: { provider?: string; model?: string; endpoint?: string; jevModel?: string; jevEnabled?: boolean }; requireOperator?: MiddlewareHandler<AppBindings> }) {
  const registration = input.registration ?? new InternalAiRegistration(async () => { throw new Error("registration unavailable"); });
  const auth = input.requireOperator ?? requirePlatformOperator("subscription.manage");
  const json = async (c: { req: { json(): Promise<unknown> } }) => { try { return await c.req.json(); } catch { throw new HttpError(400, "internal-ai-body-invalid", "请求体不是合法 JSON"); } };
  const reasonOf = (payload: unknown) => normalizeReason((payload as { reason?: unknown } | null)?.reason);
  return new Hono<AppBindings>()
    .get("/api/ops/internal-ai/runtime", auth, c => c.json({
      provider: label(input.runtime.provider), model: label(input.runtime.model), endpointHost: endpointHost(input.runtime.endpoint),
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
      const attempts = await input.gate.store.page(id, after);
      const target = await input.gate.store.target();
      // 固定字段投影，绝不序列化config任意对象/请求/响应/工具载荷。
      return c.json({ target: { ...target, totalLimit: 1000000000, attemptLimit: 30, remaining: Math.max(0, 1000000000 - target.spent - target.reserved) }, activity: id, enabled: activity.enabled, approvalRevision: activity.approval_revision ?? null,
        limits: { total: activity.total_limit, perAttempt: activity.per_attempt_limit, attempts: activity.attempt_limit },
        spent: activity.spent, reserved: activity.reserved, attemptsUsed: activity.attempts,
        remaining: Math.max(0, activity.total_limit - activity.spent - activity.reserved), moneyUnit: "nanoUSD", currency: "USD",
        priceRevisions: activity.price_revisions,
        balance: { status: activity.balance_evidence_hash ? "reviewed-evidence" : "unavailable", amount: activity.balance_nano_usd ?? null, currency: activity.balance_currency ?? null, source: activity.balance_source && /^reviewed-document:[0-9a-f]{64}$/.test(activity.balance_source) ? activity.balance_source : null, evidenceHash: activity.balance_evidence_hash ?? null, sampledAt: activity.balance_sampled_at ?? null, expiresAt: activity.evidence_expires_at ?? null, autoTopupDisabled: activity.auto_topup_disabled, serviceApproved: activity.service_approved },
        attempts: attempts.map(a => ({ id: String(a.id), sequence: a.sequence, retryIndex: a.retry_index, runHash: a.run_hash, keyHash: a.key_hash, logicalHash: a.logical_hash, stage: a.stage, state: a.state, provider: a.provider, model: a.model, actualModel: a.actual_model ?? null, requestId: a.request_id ?? null, usage: a.usage ?? null, usageSource: a.usage_source, priceRevision: a.price_revision, currency: a.currency, reserved: a.reserved, cost: a.cost ?? null, startedAt: a.started_at, endedAt: a.ended_at })),
        nextAfter: attempts.length === 50 ? attempts.at(-1)?.sequence : null,
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
      const parsed = z.object({ revision: z.number().int().positive(), reason: z.string().min(1).max(500) }).strict().safeParse(payload);
      if (!parsed.success) throw new HttpError(400, "internal-ai-revision-invalid", "必须指定正整数登记版本");
      const summary = await registration.enable({ activity: id, revision: parsed.data.revision, operator: c.var.platformOperator.subject, reason: reasonOf(payload), runtime: input.runtime });
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
  { provider: "sensenova", host: "token.sensenova.cn", capabilities: [], reason: "SenseNova 当前没有已核定的官方只读 balance/plan/usage 接口；不得凭 OpenAI-compatible 协议或 .ai 文档推断 .cn 计价" },
];
