import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { createOpsEmployeeRuntimeRoutes } from "./ops-employee-runtime";

const allow: () => MiddlewareHandler<AppBindings> = () => async (_c, next) => next();
const deny: () => MiddlewareHandler<AppBindings> = () => async (c) => c.json({ error: "forbidden" }, 403);

const sampleHealth = () => ({
  started: true,
  startedAt: "2026-10-01T00:00:00.000Z",
  uptimeMs: 3_600_000,
  sessions: { open: 3, openRetries: 1, openFailures: 0 },
  windows: { running: 1, queued: 0, completed: 12, crashed: 0, aborted: 1 },
  triggers: { enqueued: 14, coalesced: 0, pendingApprox: 0, running: 1, completed: 12, failed: 1, waiting: 0 },
  retries: 1,
  tokenUsage: {
    providerInputTokens: 1200, providerOutputTokens: 300,
    estimatedInputTokens: 0, estimatedOutputTokens: 0, calls: 4,
  },
  lease: { activeWindows: 1, oldestWindowAgeMs: 4000 },
  connections: {
    activeSessions: 3, connects: 3, reconnects: 1, disconnects: 1,
    renewals: 2, renewalFailures: 0, invalidated: 0,
  },
  reconcile: { runs: 2, scanned: 9, reclaimed: 3, lastRunAt: "2026-10-01T00:05:00.000Z" },
  shutdown: { runs: 0, timedOut: false, abortedWindows: 0, durationMs: null },
  signals: 1,
  startup: {
    state: "done" as const,
    startedAt: "2026-10-01T00:00:00.000Z",
    finishedAt: "2026-10-01T00:00:05.000Z",
    workspacesTotal: 2,
    workspacesDone: 2,
    employeesTotal: 3,
    employeesReconciled: 3,
    employeesFailed: 0,
    inFlight: 0,
    warmup: { databases: 2, credentials: 3 },
    lastError: null,
  },
});

describe("GET /api/ops/employee-runtime/health", () => {
  test("运维可读取健康快照：指标齐全且不含 secret/token/payload", async () => {
    const app = createOpsEmployeeRuntimeRoutes({
      health: sampleHealth,
      requireOperator: allow,
    });
    const res = await app.request("/api/ops/employee-runtime/health");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    for (const key of [
      "sessions", "windows", "triggers", "retries", "tokenUsage",
      "lease", "connections", "reconcile", "shutdown", "signals", "startup",
    ]) {
      expect(body).toHaveProperty(key);
    }
    // 快照整体序列化后不得出现凭证/原始 token 值（tokenUsage 计数键名是合法字段）。
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/secret|password|authorization|bearer|jwks/i);
    expect(raw).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // JWT 形态
    expect(raw).not.toContain("s3cret");
  });

  test("未过 operator 鉴权 → 中间件决定直接生效（403）", async () => {
    const app = createOpsEmployeeRuntimeRoutes({
      health: () => { throw new Error("must not be reached"); },
      requireOperator: deny,
    });
    const res = await app.request("/api/ops/employee-runtime/health");
    expect(res.status).toBe(403);
  });
});
