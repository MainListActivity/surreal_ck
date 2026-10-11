import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { handleError } from "../middleware/error";
import {
  SurrealHealthExerciseError,
  type SurrealHealthExerciseOutcome,
  type SurrealHealthExerciseStatus,
} from "../ops/surreal-health-exercise";
import { createOpsSurrealHealthRoutes } from "./ops-surreal-health";

const allowOperator: () => MiddlewareHandler<AppBindings> = () => async (c, next) => {
  c.set("platformOperator", {
    subject: "operator:tester",
    kind: "agent",
    capabilities: ["quota.read"],
  });
  await next();
};
const deny: () => MiddlewareHandler<AppBindings> = () => async (c) =>
  c.json({ error: "forbidden" }, 403);

function build(input: {
  exercise?: SurrealHealthExerciseOutcome | Error;
  status?: SurrealHealthExerciseStatus;
  requireOperator?: () => MiddlewareHandler<AppBindings>;
}) {
  const calls: Array<{ actorSubject: string; holdMs?: number; reason?: string }> = [];
  const service = {
    async exercise(args: { actorSubject: string; holdMs?: number; reason?: string }) {
      calls.push(args);
      if (input.exercise instanceof Error) throw input.exercise;
      return (
        input.exercise ?? {
          exercised: true,
          holdMs: 5_000,
          resumeAt: "2026-10-11T12:00:05.000Z",
          probe: { state: "disconnected", reconnectAttempts: 1, poolSize: 0 },
        }
      );
    },
    status() {
      return (
        input.status ?? {
          probe: { state: "connected", reconnectAttempts: 0, poolSize: 0 },
          exercise: {
            inFlight: false,
            lastExercisedAt: null,
            minIntervalMs: 300_000,
            defaultHoldMs: 5_000,
            maxHoldMs: 30_000,
          },
        }
      );
    },
  };
  const app = createOpsSurrealHealthRoutes({
    service,
    requireOperator: input.requireOperator ?? allowOperator,
  });
  app.onError(handleError);
  return { app, calls };
}

describe("ops surreal-health routes", () => {
  test("GET /api/ops/surreal-health/status：返回探测快照与节流参数", async () => {
    const { app } = build({});

    const res = await app.request("/api/ops/surreal-health/status");

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, never>;
    expect(body).toHaveProperty("probe");
    expect(body).toHaveProperty("exercise");
  });

  test("POST exercise：透传 operator subject 与 holdMs/reason，返回演练结果", async () => {
    const { app, calls } = build({});

    const res = await app.request("/api/ops/surreal-health/exercise", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ holdMs: 8_000, reason: "fa41103d QA 验收" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.exercised).toBe(true);
    expect(body.holdMs).toBe(5_000);
    expect(body.resumeAt).toBe("2026-10-11T12:00:05.000Z");
    expect(calls).toEqual([
      { actorSubject: "operator:tester", holdMs: 8_000, reason: "fa41103d QA 验收" },
    ]);
  });

  test("POST exercise 空 body：走默认参数", async () => {
    const { app, calls } = build({});

    const res = await app.request("/api/ops/surreal-health/exercise", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(calls).toEqual([{ actorSubject: "operator:tester" }]);
  });

  test("非法入参：非整数 holdMs / 非对象 body / 非法 reason → 400 且不进服务", async () => {
    const { app, calls } = build({});

    for (const body of [
      JSON.stringify({ holdMs: 1.5 }),
      JSON.stringify({ holdMs: "5000" }),
      JSON.stringify([1]),
      JSON.stringify({ reason: "" }),
      JSON.stringify({ reason: "x".repeat(201) }),
    ]) {
      const res = await app.request("/api/ops/surreal-health/exercise", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(res.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  test("限频错误映射：rate_limited → 429 + retryAfterMs；其他错误 → 503", async () => {
    const rateLimited = build({
      exercise: new SurrealHealthExerciseError("rate_limited", "limited", 42_000),
    });
    const res = await rateLimited.app.request("/api/ops/surreal-health/exercise", {
      method: "POST",
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; details?: { retryAfterMs?: number } } };
    expect(body.error.code).toBe("surreal-health-exercise-rate_limited");
    expect(body.error.details?.retryAfterMs).toBe(42_000);

    const unavailable = build({
      exercise: new SurrealHealthExerciseError("unavailable", "probe unavailable"),
    });
    const res2 = await unavailable.app.request("/api/ops/surreal-health/exercise", {
      method: "POST",
    });
    expect(res2.status).toBe(503);
  });

  test("非授权访问被拒：requireOperator deny → 403 且不进服务", async () => {
    const { app, calls } = build({ requireOperator: deny });

    const res = await app.request("/api/ops/surreal-health/exercise", {
      method: "POST",
    });

    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
    const status = await app.request("/api/ops/surreal-health/status");
    expect(status.status).toBe(403);
  });
});
