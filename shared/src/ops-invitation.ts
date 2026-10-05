import { z } from "zod";

/**
 * G2 运营代办开通（POST /api/ops/invitations）请求体。
 * 组合动作：IdP 建用户（幂等复用）→ 以其为 owner 建 workspace → 绑定产品
 * 权益（内容访问）→ 授予 AI 额度桶。链路为异步契约：POST 在同步窗口内
 * 完成则直接返回结果，超时返回 processing 供轮询 GET；激活链接经
 * collect-delivery 一次性收取。activation_url 属一次性凭证，不写审计、不入证据。
 */
export const createOpsInvitationSchema = z.object({
  email: z.string().trim().email().max(200),
  displayName: z.string().trim().min(1).max(80),
  workspaceSlug: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u)
    .max(40),
  workspaceName: z.string().trim().min(1).max(80).optional(),
  /** 既有商业套餐键（manual 分配，不产生付费事实）；默认 pro。 */
  planKey: z.string().trim().regex(/^[a-z][a-z0-9_]{1,63}$/u).default("pro"),
  /** 缺省时回退 pro_trial_configuration:current 批准的产品版本。 */
  productPlanRevisionId: z
    .string()
    .startsWith("product_plan_revision:")
    .optional(),
  aiAllowance: z.object({
    amount: z.number().int().positive(),
    expiresAt: z.string().datetime(),
    label: z.string().trim().min(1).max(80).default("邀请试点 AI 额度"),
  }).strict(),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().min(8).max(200),
}).strict();

export type CreateOpsInvitation = z.infer<typeof createOpsInvitationSchema>;
