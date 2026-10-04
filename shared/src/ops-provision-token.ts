import { z } from "zod";

/**
 * IdP provision token 免部署轮换（POST /api/ops/idp-provision-token/rotate）
 * 请求体。token 为 ma_hono service principal 的 opaque bearer（base64url），
 * 仅经请求体传入、密封入库；服务端不回显、不写日志与审计。
 */
export const rotateIdpProvisionTokenSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u),
}).strict();

export type RotateIdpProvisionToken = z.infer<typeof rotateIdpProvisionTokenSchema>;
