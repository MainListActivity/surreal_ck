import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { employeeRuntimeHealth } from "../../ai/office/employee-service";
import { requirePlatformOperator } from "../ops/operator-auth";
import type { EmployeeRuntimeMetrics } from "../../ai/office/employee-trigger-runtime";
import type { EmployeeStartupProgress } from "../../ai/office/employee-supervisor";

/**
 * 虚拟员工 runtime 健康/容量端点（VER06）。
 * GET /api/ops/employee-runtime/health → 进程内指标快照 + 启动监督进度；
 * 只有计数、时间戳与毫秒数，绝不含 secret、token 或业务 payload。
 */
export function createOpsEmployeeRuntimeRoutes(input: Readonly<{
  health?: () => EmployeeRuntimeMetrics & { startup: EmployeeStartupProgress };
  requireOperator?: () => MiddlewareHandler<AppBindings>;
}> = {}) {
  const health = input.health ?? employeeRuntimeHealth;
  const requireOperator = input.requireOperator ?? (() => requirePlatformOperator());
  return new Hono<AppBindings>()
    .get("/api/ops/employee-runtime/health", requireOperator(), (c) => c.json(health()));
}
