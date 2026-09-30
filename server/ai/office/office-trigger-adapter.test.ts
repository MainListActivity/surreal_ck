import { describe, expect, test } from "bun:test";
import { StringRecordId } from "surrealdb";
import type {
  EmployeeLifecycle,
  EmployeeLifecycleResult,
} from "./employee-lifecycle";
import type { EmployeeTriggerRuntime, EnqueueResult } from "./employee-trigger-runtime";
import {
  bootstrapOffice,
  notifyOfficeTask,
  OFFICE_BOOTSTRAP_KEY,
  OFFICE_MANAGER_REQUEST_KEY,
  officeManagerEmployeeId,
  reconcileOfficeWorkspace,
  type OfficeBootstrapDeps,
} from "./office-trigger-adapter";
import { OFFICE_TASK_REASON } from "./project-manager";

/**
 * adapter 单元测试：fake lifecycle / runtime / caller session 验证
 * bootstrap 前置校验、稳定幂等键、reconcile 的扫描→投递翻译。
 */

type ProvisionCall = { requestKey: string; roleKey?: string; slug: string };

function fakeLifecycle(result: EmployeeLifecycleResult = {
  kind: "ok",
  employee: { id: "user:ve_pm", subject: "ve-pm", displayName: "项目经理", roleKey: "project-manager", status: "active" },
  created: true,
}) {
  const calls: ProvisionCall[] = [];
  const lifecycle = {
    provision: async (input: { slug: string; requestKey: string; roleKey?: string }) => {
      calls.push({ requestKey: input.requestKey, roleKey: input.roleKey, slug: input.slug });
      return result;
    },
  } as unknown as EmployeeLifecycle;
  return { lifecycle, calls };
}

type EnqueueCall = { employeeId: string; reason: string; payloadRef?: string; idempotencyKey: string };

function fakeRuntime(outcome: EnqueueResult["outcome"] = "completed") {
  const enqueued: EnqueueCall[] = [];
  const reconciled: string[] = [];
  const handlers = new Set<string>();
  let started = 0;
  const runtime = {
    start() { started += 1; },
    registerHandler(reason: string) { handlers.add(reason); },
    async enqueue(d: EnqueueCall) {
      enqueued.push(d);
      return { outcome, triggerId: "employee_trigger:t1" } as EnqueueResult;
    },
    async reconcile(input: { database: string; employeeId: string }) {
      reconciled.push(input.employeeId);
      return { scanned: 0, reclaimed: 0, completed: 0, waiting: 0, failed: 0 };
    },
    async stop() {},
  } as unknown as EmployeeTriggerRuntime;
  return { runtime, enqueued, reconciled, handlers, started: () => started };
}

function fakeCallerSession(meta: { goal?: string; primary_contact?: unknown; state?: string } | null | "deny") {
  const queries: string[] = [];
  const session = {
    async query(sql: string) {
      queries.push(sql);
      if (meta === "deny") throw new Error("auth-failed");
      if (sql.includes("FROM office_meta:office")) {
        return [meta ? [{ goal: meta.goal, primary_contact: meta.primary_contact, state: meta.state }] : []];
      }
      return [[]];
    },
    async close() {},
  };
  return { session, queries };
}

function deps(over: Partial<OfficeBootstrapDeps> = {}): OfficeBootstrapDeps {
  return {
    lifecycle: fakeLifecycle().lifecycle,
    triggerRuntime: fakeRuntime().runtime,
    resolveWorkspace: async (slug) => (slug === "acme" ? { dbName: "ws_acme" } : null),
    callerSession: async () => fakeCallerSession({ goal: "g", primary_contact: "user:owner" }).session,
    ...over,
  };
}

describe("office bootstrap", () => {
  test("office_meta 缺 goal / primary_contact → meta-incomplete，不开岗不投递", async () => {
    const { lifecycle, calls } = fakeLifecycle();
    const { runtime, enqueued } = fakeRuntime();
    const { session } = fakeCallerSession({ goal: "  " });
    const result = await bootstrapOffice(
      deps({ lifecycle, triggerRuntime: runtime, callerSession: async () => session }),
      { slug: "acme", callerToken: "t" },
    );
    expect(result).toEqual({ kind: "meta-incomplete", missing: ["goal", "primary_contact"] });
    expect(calls).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  test("meta 就绪 → 稳定 requestKey 开岗 + 恒定幂等键投递；重试收敛", async () => {
    const { lifecycle, calls } = fakeLifecycle();
    const { runtime, enqueued, handlers } = fakeRuntime();
    const { session, queries } = fakeCallerSession({
      goal: "跑出风险清单",
      primary_contact: "user:owner",
      state: "onboarding",
    });
    const d = deps({ lifecycle, triggerRuntime: runtime, callerSession: async () => session });

    const first = await bootstrapOffice(d, { slug: "acme", callerToken: "t" });
    expect(first).toMatchObject({ kind: "ok", employeeId: "user:ve_pm", outcome: "completed" });
    const second = await bootstrapOffice(d, { slug: "acme", callerToken: "t" });
    expect(second).toMatchObject({ kind: "ok", employeeId: "user:ve_pm" });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.requestKey).toBe(OFFICE_MANAGER_REQUEST_KEY);
      expect(call.roleKey).toBe("project-manager");
    }
    expect(enqueued).toHaveLength(2);
    for (const e of enqueued) {
      expect(e).toMatchObject({
        employeeId: "user:ve_pm",
        reason: "office-bootstrap",
        payloadRef: "office_meta:office",
        idempotencyKey: OFFICE_BOOTSTRAP_KEY,
      });
    }
    // state 推进到 active 的写经调用者会话发生。
    expect(queries.some((q) => q.includes('state = "active"'))).toBe(true);
    // PM 的 handler 注册到了 runtime。
    expect(handlers.has("office-bootstrap")).toBe(true);
    expect(handlers.has(OFFICE_TASK_REASON)).toBe(true);
  });

  test("workspace 不存在 / 调用者被拒 / 开岗失败 / 触发失败 各有结构化结果", async () => {
    expect(
      (await bootstrapOffice(deps(), { slug: "ghost", callerToken: "t" })).kind,
    ).toBe("workspace-not-found");

    const denied = deps({ callerSession: async () => { throw new Error("auth"); } });
    expect(
      (await bootstrapOffice(denied, { slug: "acme", callerToken: "t" })).kind,
    ).toBe("caller-denied");

    const badProvision = deps({ lifecycle: fakeLifecycle({ kind: "role-not-found" }).lifecycle });
    expect(
      (await bootstrapOffice(badProvision, { slug: "acme", callerToken: "t" })),
    ).toEqual({ kind: "provision-failed", reason: "role-not-found" });

    const failedRuntime = deps({ triggerRuntime: fakeRuntime("failed").runtime });
    expect(
      (await bootstrapOffice(failedRuntime, { slug: "acme", callerToken: "t" })).kind,
    ).toBe("trigger-failed");
  });

  test("officeManagerEmployeeId 与 lifecycle 同一 sha256(db:key) 推导", () => {
    expect(officeManagerEmployeeId("ws_acme")).toMatch(/^user:ve_[0-9a-f]{24}$/);
    expect(officeManagerEmployeeId("ws_acme")).toBe(officeManagerEmployeeId("ws_acme"));
    expect(officeManagerEmployeeId("ws_acme")).not.toBe(officeManagerEmployeeId("ws_other"));
  });
});

describe("office task dispatch + reconcile", () => {
  test("notifyOfficeTask 把任务翻译成 office-task 触发（payloadRef + 稳定键）", async () => {
    const { runtime, enqueued } = fakeRuntime();
    const result = await notifyOfficeTask(runtime, {
      database: "ws_acme",
      assigneeId: "user:ve_pm",
      taskId: "office_task:t1",
    });
    expect(result.outcome).toBe("completed");
    expect(enqueued).toEqual([{
      database: "ws_acme",
      employeeId: "user:ve_pm",
      reason: "office-task",
      payloadRef: "office_task:t1",
      chainDepth: 0,
      idempotencyKey: "office-task:office_task:t1",
    }]);
  });

  test("reconcile：meta 未就绪跳过；就绪则回收窗口 + 补投 bootstrap + 派发未完成任务", async () => {
    // meta 未就绪：零投递。
    const cold = fakeRuntime();
    await reconcileOfficeWorkspace({
      runtime: cold.runtime,
      root: {
        async query(sql: string) {
          if (sql.includes("FROM office_meta:office")) return [[{ goal: "", primary_contact: null }]];
          return [[]];
        },
      },
      database: "ws_cold",
    });
    expect(cold.enqueued).toHaveLength(0);

    // 就绪 + PM active + 一条开放任务 → bootstrap 补投 + office-task 派发。
    const db = "ws_recon";
    const pmId = officeManagerEmployeeId(db);
    const { runtime, enqueued, reconciled } = fakeRuntime("coalesced");
    const summary = await reconcileOfficeWorkspace({
      runtime,
      root: {
        async query(sql: string, params?: Record<string, unknown>) {
          if (sql.includes("FROM office_meta:office")) {
            return [[{ goal: "g", primary_contact: "user:owner" }]];
          }
          if (sql.includes("FROM user WHERE kind")) {
            return [[{ id: new StringRecordId(pmId) }]];
          }
          if (sql.includes("FROM office_task")) {
            return [[{ id: new StringRecordId("office_task:t1"), assignee: new StringRecordId(pmId) }]];
          }
          void params;
          return [[]];
        },
      },
      database: db,
    });
    expect(reconciled).toContain(pmId);
    const reasons = enqueued.map((e) => `${e.reason}:${e.idempotencyKey}`);
    expect(reasons).toContain("office-bootstrap:office-bootstrap");
    expect(reasons).toContain("office-task:office-task:office_task:t1");
    expect(summary.coalesced).toBe(2);
    expect(summary.failed).toBe(0);
  });
});
