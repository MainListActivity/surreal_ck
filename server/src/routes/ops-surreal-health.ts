import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requirePlatformOperator } from "../ops/operator-auth";
import {
  SurrealHealthExerciseError,
  SurrealHealthExerciseService,
  type SurrealHealthExercisePort,
} from "../ops/surreal-health-exercise";

function fail(error: unknown): never {
  if (!(error instanceof SurrealHealthExerciseError)) throw error;
  const status = error.code === "rate_limited"
    ? 429
    : error.code === "invalid_hold"
      ? 400
      : 503;
  throw new HttpError(
    status,
    `surreal-health-exercise-${error.code}`,
    error.message,
    error.retryAfterMs !== undefined
      ? { retryAfterMs: error.retryAfterMs }
      : undefined,
  );
}

function operatorSubject(c: { var: AppBindings["Variables"] }): string {
  const operator = c.var.platformOperator;
  if (!operator) {
    throw new HttpError(403, "platform-operator-required", "需要平台运营身份");
  }
  return operator.subject;
}

/**
 * /health 探测连接受控 down→up 演练端点（补 fa41103d 验收条件的受控故障注入）。
 * 仅 platform operator 可调用：鉴权沿用 requirePlatformOperator 体系，
 * 限频/时长上限/并发幂等与审计由 SurrealHealthExerciseService 保证。
 * 断开对象是 /health 专用探测连接（与业务 root 连接物理隔离），
 * 演练期间业务路径（既有会话/查询）不受影响。
 */
export function createOpsSurrealHealthRoutes(input: Readonly<{
  service?: SurrealHealthExercisePort;
  requireOperator?: () => MiddlewareHandler<AppBindings>;
}> = {}) {
  const service = input.service ?? new SurrealHealthExerciseService();
  const requireOperator = input.requireOperator ?? (() => requirePlatformOperator());
  return new Hono<AppBindings>()
    .get("/api/ops/surreal-health/status", requireOperator(), (c) => {
      return c.json(service.status());
    })
    .post("/api/ops/surreal-health/exercise", requireOperator(), async (c) => {
      const body = await c.req.json().catch(() => null);
      if (
        body !== null
        && (typeof body !== "object" || Array.isArray(body))
      ) {
        throw new HttpError(
          400,
          "surreal-health-exercise-invalid_request",
          "演练请求体必须是 JSON object",
        );
      }
      const holdMs = (body as { holdMs?: unknown } | null)?.holdMs;
      if (
        holdMs !== undefined
        && (typeof holdMs !== "number" || !Number.isInteger(holdMs))
      ) {
        throw new HttpError(
          400,
          "surreal-health-exercise-invalid_hold",
          "holdMs must be an integer number of milliseconds",
        );
      }
      const reason = (body as { reason?: unknown } | null)?.reason;
      if (
        reason !== undefined
        && (typeof reason !== "string" || reason.length === 0 || reason.length > 200)
      ) {
        throw new HttpError(
          400,
          "surreal-health-exercise-invalid_request",
          "reason must be a non-empty string of at most 200 characters",
        );
      }
      try {
        return c.json(await service.exercise({
          actorSubject: operatorSubject(c),
          ...(holdMs !== undefined ? { holdMs } : {}),
          ...(reason !== undefined ? { reason } : {}),
        }));
      } catch (error) {
        return fail(error);
      }
    });
}
