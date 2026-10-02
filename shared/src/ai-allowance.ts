import { z } from "zod";

/** LCA05 工作区共享 AI 额度：前后端共享契约。 */

/** 当前唯一接入计量的动作：Router chat run（单位是"AI 研究额度"，不暴露 token）。 */
export const AI_CHAT_ACTION_KEY = "research";

export const aiAllowanceChannels = ["interactive", "employee", "api_mcp", "batch"] as const;
export type AiAllowanceChannel = (typeof aiAllowanceChannels)[number];

export const aiAllowanceBucketKinds = ["plan_cycle", "purchased", "compensation"] as const;
export type AiAllowanceBucketKind = (typeof aiAllowanceBucketKinds)[number];

export type AiAllowanceSource = {
  kind: "subscription" | "trial" | "none";
  sourceId: string | null;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
};
export function aiAllowancePlanPrefix(source: AiAllowanceSource | null, now = Date.now()): string | null {
  if (!source || !(source.kind === "trial" || source.kind === "subscription") || !source.sourceId || !source.effectiveFrom) return null;
  const from = Date.parse(source.effectiveFrom);
  const until = source.effectiveUntil === null ? Infinity : Date.parse(source.effectiveUntil);
  return Number.isFinite(from) && from <= now && until > now
    ? `${source.kind}:${source.sourceId}:` : null;
}
export type AiAllowanceConsumptionReason = "available" | "expired" | "terminated" | "source_mismatch" | "suspended" | "pending" | "invalid";
export function aiAllowanceConsumptionReason(bucket: {
  kind: string; period_key: string; status: string; terminated_at?: unknown;
  effective_from: string; expires_at: string;
}, planPrefix: string | null, now = Date.now()): AiAllowanceConsumptionReason {
  const from = Date.parse(bucket.effective_from), until = Date.parse(bucket.expires_at);
  if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from
    || !aiAllowanceBucketKinds.includes(bucket.kind as AiAllowanceBucketKind)) return "invalid";
  if (until <= now) return "expired";
  if (bucket.terminated_at != null) return "terminated";
  if (bucket.kind === "plan_cycle" && !(planPrefix && bucket.period_key.startsWith(planPrefix))) return "source_mismatch";
  if (bucket.status === "suspended") return "suspended";
  if (bucket.status !== "active") return "invalid";
  if (from > now) return "pending";
  return "available";
}

/** 与纯函数同一规则；候选读取和事务条件扣减必须使用同一谓词。 */
export const AI_ALLOWANCE_CONSUMABLE_SQL = `status = "active" AND effective_from <= time::now()
  AND expires_at > time::now() AND expires_at > effective_from AND terminated_at = NONE
  AND kind INSIDE ["plan_cycle", "purchased", "compensation"]
  AND (kind != "plan_cycle" OR string::starts_with(period_key, $planPrefix))`;

export function emptyAiAllowanceBalance() {
  return { available: 0, reserved: 0, suspended: 0, terminated: 0, expired: 0, pending: 0, unavailable: 0 };
}
export function addAiAllowanceBalance(balance: ReturnType<typeof emptyAiAllowanceBalance>, reason: AiAllowanceConsumptionReason,
  available: number, reserved: number): void {
  if (reason === "available") { balance.available += available; balance.reserved += reserved; }
  else {
    const category = reason === "source_mismatch" ? "terminated" : reason === "invalid" ? "unavailable" : reason;
    balance[category] += available + reserved;
  }
}

export type AiAllowanceBucketView = {
  id: string;
  kind: AiAllowanceBucketKind;
  label: string;
  period_key: string;
  total: number;
  available: number;
  reserved: number;
  settled: number;
  status: "active" | "suspended";
  effective_from: string;
  expires_at: string;
  expired: boolean;
  /** LCA08：商业来源终止标记（试用转付费），余额不再可消费、不复活。 */
  terminated: boolean;
  consumptionReason?: AiAllowanceConsumptionReason;
};

export type AiAllowanceLedgerView = {
  id: string;
  kind: "grant" | "reserve" | "settle" | "release" | "expire" | "writeoff";
  amount: number;
  note: string;
  created_at: string;
};

export type AiAllowanceNoticeView = {
  id: string;
  period_key: string;
  threshold: 50 | 80 | 100;
  message: string;
  created_at: string;
};

export type AiAllowanceSnapshot = {
  metered: boolean;
  quote: { action: string; amount: number; revisionLabel: string; tierLabel: string } | null;
  available: number;
  reserved: number;
  suspended: number;
  /** 已终止桶（试用转付费等商业来源终止）内仍有余额，不再可消费。 */
  terminated: number;
  expired: number;
  pending: number;
  unavailable: number;
  buckets: AiAllowanceBucketView[];
  entries: AiAllowanceLedgerView[];
  notices: AiAllowanceNoticeView[];
};

/** 运营授予额度桶请求体（POST /api/ops/ai-allowance/grants）。 */
export const grantAiAllowanceSchema = z.object({
  workspace: z.string().min(1),
  kind: z.enum(aiAllowanceBucketKinds),
  amount: z.number().int().positive(),
  label: z.string().min(1),
  periodKey: z.string().min(1),
  effectiveFrom: z.string().datetime().optional(),
  expiresAt: z.string().datetime(),
  source: z.string().optional(),
});
export type GrantAiAllowanceRequest = z.infer<typeof grantAiAllowanceSchema>;
