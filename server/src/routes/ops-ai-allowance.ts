import { Hono } from "hono";
import { grantAiAllowanceSchema } from "@surreal-ck/shared";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requirePlatformOperator } from "../ops/operator-auth";
import { AiAllowanceError, type AiAllowanceService } from "../ai-allowance/service";

/**
 * 运营授予 AI 额度桶：往目标 workspace database 写独立额度桶 + grant 账本。
 * workspace 形参同时接受 slug 与 db_name（_system 里两者都唯一）。
 */
export function createOpsAiAllowanceRoutes(input: { service: AiAllowanceService }) {
  return new Hono<AppBindings>().post(
    "/api/ops/ai-allowance/grants",
    requirePlatformOperator("subscription.manage"),
    async (c) => {
      const parsed = grantAiAllowanceSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new HttpError(400, "ai-allowance-invalid-request", "额度授予请求无效", parsed.error.flatten());
      }
      const operator = c.var.platformOperator;
      const body = parsed.data;
      const db = await input.service.resolveWorkspaceDb(body.workspace);
      if (!db) {
        throw new HttpError(404, "ai-allowance-workspace-not-found", "workspace 不存在");
      }
      try {
        const result = await input.service.grant({
          db,
          kind: body.kind,
          amount: body.amount,
          label: body.label,
          periodKey: body.periodKey,
          effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : new Date(),
          expiresAt: new Date(body.expiresAt),
          source: body.source,
          operatorSubject: operator?.subject ?? "unknown",
        });
        return c.json(result, 201);
      } catch (error) {
        if (error instanceof AiAllowanceError) {
          throw new HttpError(400, error.code, error.message, error.details);
        }
        throw error;
      }
    },
  );
}
