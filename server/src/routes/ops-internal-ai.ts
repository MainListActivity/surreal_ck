import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppBindings } from "../hono-types";
import { requirePlatformOperator } from "../ops/operator-auth";
import type { InternalAiGate } from "../internal-ai/gate";
import { endpointHost, TARIFFS } from "../internal-ai/pricing";
import { HttpError } from "../http-error";
function dependencyVersion(): string | null {
  try { const entry = createRequire(import.meta.url).resolve("@mastra/core"); const parsed: unknown = JSON.parse(readFileSync(join(dirname(entry), "../package.json"), "utf8")); return parsed && typeof parsed === "object" && "version" in parsed && typeof parsed.version === "string" ? parsed.version : null; } catch { return null; }
}
const label = (value: string | undefined) => value && /^[a-zA-Z0-9_.\/-]{1,100}$/.test(value) ? value : null;
export function createOpsInternalAiRoutes(input: { gate: InternalAiGate; runtime: { provider?: string; model?: string; endpoint?: string; jevModel?: string }; requireOperator?: MiddlewareHandler<AppBindings> }) {
  const auth = input.requireOperator ?? requirePlatformOperator("subscription.manage");
  return new Hono<AppBindings>()
    .get("/api/ops/internal-ai/runtime", auth, c => c.json({
      provider: label(input.runtime.provider), model: label(input.runtime.model), endpointHost: endpointHost(input.runtime.endpoint ?? (input.runtime.provider === "openai" ? "https://api.openai.com/v1" : undefined)),
      jevModel: label(input.runtime.jevModel), jevEndpointHost: "api.typesafe.ai", mastraVersion: dependencyVersion(),
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
        balance: { status: activity.balance_evidence_hash ? "reviewed-evidence" : "unavailable", amount: activity.balance_nano_usd ?? null, currency: activity.balance_currency ?? null, source: activity.balance_source ?? null, evidenceHash: activity.balance_evidence_hash ?? null, sampledAt: activity.balance_sampled_at ?? null, expiresAt: activity.evidence_expires_at ?? null, autoTopupDisabled: activity.auto_topup_disabled, serviceApproved: activity.service_approved },
        attempts: attempts.map(a => ({ id: String(a.id), sequence: a.sequence, runHash: a.run_hash, keyHash: a.key_hash, logicalHash: a.logical_hash, stage: a.stage, state: a.state, provider: a.provider, model: a.model, actualModel: a.actual_model ?? null, requestId: a.request_id ?? null, usage: a.usage ?? null, usageSource: a.usage_source, priceRevision: a.price_revision, currency: a.currency, reserved: a.reserved, cost: a.cost ?? null, startedAt: a.started_at, endedAt: a.ended_at })),
        nextAfter: attempts.length === 50 ? attempts.at(-1)?.sequence : null,
      });
    });
}
