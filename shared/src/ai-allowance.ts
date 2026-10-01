import { z } from "zod";

/** LCA05 工作区共享 AI 额度：前后端共享契约。 */

/** 当前唯一接入计量的动作：Router chat run（单位是"AI 研究额度"，不暴露 token）。 */
export const AI_CHAT_ACTION_KEY = "research";

export const aiAllowanceChannels = ["interactive", "employee", "api_mcp", "batch"] as const;
export type AiAllowanceChannel = (typeof aiAllowanceChannels)[number];

export const aiAllowanceBucketKinds = ["plan_cycle", "purchased", "compensation"] as const;
export type AiAllowanceBucketKind = (typeof aiAllowanceBucketKinds)[number];

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
