import { describe, expect, test } from "bun:test";
import { StringRecordId } from "surrealdb";
import type {
  EmployeeLifecycle,
  EmployeeLifecycleResult,
} from "./employee-lifecycle";
import type { EmployeeTriggerRuntime, EnqueueResult } from "./employee-trigger-runtime";
import {
  bootstrapOffice,
  dispatchOfficeTask,
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

function fakeCallerSession(meta: { goal?: string; primary_contact?: unknown; state?: string; import_state?: string } | null | "deny") {
  const queries: string[] = [];
  const session = {
    async query(sql: string) {
      queries.push(sql);
      if (meta === "deny") throw new Error("auth-failed");
      if (sql.includes("FROM office_meta:office")) {
        return [meta ? [{
          goal: meta.goal,
          primary_contact: meta.primary_contact,
          state: meta.state,
          import_state: meta.import_state,
        }] : []];
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
    callerSession: async () => fakeCallerSession({
      goal: "g",
      primary_contact: "user:owner",
      import_state: "skipped",
    }).session,
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
    expect(result).toEqual({ kind: "meta-incomplete", missing: ["goal", "primary_contact", "import_state"] });
    expect(calls).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  test("VO06 导入门禁：goal/contact 就绪但 import 未决议 → meta-incomplete，不开岗不投递", async () => {
    const { lifecycle, calls } = fakeLifecycle();
    const { runtime, enqueued } = fakeRuntime();
    for (const importState of [undefined, "failed"]) {
      const { session } = fakeCallerSession({
        goal: "跑出风险清单",
        primary_contact: "user:owner",
        state: "onboarding",
        import_state: importState,
      });
      const result = await bootstrapOffice(
        deps({ lifecycle, triggerRuntime: runtime, callerSession: async () => session }),
        { slug: "acme", callerToken: "t" },
      );
      expect(result).toEqual({ kind: "meta-incomplete", missing: ["import_state"] });
    }
    expect(calls).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  test("已 active 的办公室不受导入门禁：bootstrap 重放幂等放行", async () => {
    const { lifecycle } = fakeLifecycle();
    const { runtime, enqueued } = fakeRuntime();
    const { session } = fakeCallerSession({
      goal: "跑出风险清单",
      primary_contact: "user:owner",
      state: "active",
      // 历史库没有 import_state 字段值。
    });
    const result = await bootstrapOffice(
      deps({ lifecycle, triggerRuntime: runtime, callerSession: async () => session }),
      { slug: "acme", callerToken: "t" },
    );
    expect(result).toMatchObject({ kind: "ok", employeeId: "user:ve_pm" });
    expect(enqueued).toHaveLength(1);
  });

  test("meta 就绪 → 稳定 requestKey 开岗 + 恒定幂等键投递；重试收敛", async () => {
    const { lifecycle, calls } = fakeLifecycle();
    const { runtime, enqueued, handlers } = fakeRuntime();
    const { session, queries } = fakeCallerSession({
      goal: "跑出风险清单",
      primary_contact: "user:owner",
      state: "onboarding",
      import_state: "skipped",
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

  test("reconcile：meta 就绪但尚无在岗员工时不投递（首次开岗只能经 bootstrap）", async () => {
    const db = "ws_nopm";
    const { runtime, enqueued, reconciled } = fakeRuntime("completed");
    const summary = await reconcileOfficeWorkspace({
      runtime,
      root: {
        async query(sql: string) {
          if (sql.includes("FROM office_meta:office")) {
            return [[{ goal: "g", primary_contact: "user:owner" }]];
          }
          return [[]];
        },
      },
      database: db,
    });
    expect(summary.employees).toBe(0);
    expect(summary.dispatched).toBe(0);
    expect(summary.failed).toBe(0);
    expect(enqueued).toHaveLength(0);
    expect(reconciled).toHaveLength(0);
  });
});

describe("office task dispatch（VO06 管理员派发）", () => {
  type TaskRow = Record<string, unknown>;

  function taskSession(task: TaskRow | null) {
    return {
      async query(sql: string) {
        if (sql.includes("FROM $task")) return [task ? [task] : []];
        return [[]];
      },
      async close() {},
    };
  }

  function dispatchDeps(task: TaskRow | null | "deny", runtime: EmployeeTriggerRuntime) {
    return {
      triggerRuntime: runtime,
      resolveWorkspace: async (slug: string) => (slug === "acme" ? { dbName: "ws_acme" } : null),
      // caller-denied 对应 SIGNIN 阶段失败（会话建不起来），而非查询抛错。
      callerSession: async () => {
        if (task === "deny") throw new Error("auth-failed");
        return taskSession(task);
      },
    };
  }

  const openAnalystTask: TaskRow = {
    id: "office_task:utask_abcd",
    status: "open",
    assignee: "user:ve_analyst",
    assignee_kind: "virtual",
    assignee_status: "active",
  };

  test("开放任务 + active 虚拟员工 assignee → office-task 触发投递", async () => {
    const { runtime, enqueued } = fakeRuntime("completed");
    const result = await dispatchOfficeTask(
      dispatchDeps(openAnalystTask, runtime),
      { slug: "acme", callerToken: "t", taskId: "office_task:utask_abcd" },
    );
    expect(result).toMatchObject({ kind: "ok", outcome: "completed" });
    expect(enqueued).toEqual([
      expect.objectContaining({
        employeeId: "user:ve_analyst",
        reason: OFFICE_TASK_REASON,
        payloadRef: "office_task:utask_abcd",
        idempotencyKey: "office-task:office_task:utask_abcd",
      }),
    ]);
  });

  test("workspace 不存在 / 调用者被拒 / 任务不存在 各有结构化结果", async () => {
    const { runtime } = fakeRuntime();
    expect(
      await dispatchOfficeTask(dispatchDeps(openAnalystTask, runtime),
        { slug: "gone", callerToken: "t", taskId: "office_task:x" }),
    ).toEqual({ kind: "workspace-not-found" });
    expect(
      await dispatchOfficeTask(dispatchDeps("deny", runtime),
        { slug: "acme", callerToken: "t", taskId: "office_task:x" }),
    ).toEqual({ kind: "caller-denied" });
    expect(
      await dispatchOfficeTask(dispatchDeps(null, runtime),
        { slug: "acme", callerToken: "t", taskId: "office_task:x" }),
    ).toEqual({ kind: "task-not-found" });
  });

  test("终态任务 / 真人 assignee / 未激活员工 拒绝投递", async () => {
    const { runtime, enqueued } = fakeRuntime();
    expect(
      await dispatchOfficeTask(
        dispatchDeps({ ...openAnalystTask, status: "done" }, runtime),
        { slug: "acme", callerToken: "t", taskId: "office_task:x" },
      ),
    ).toEqual({ kind: "task-terminal", status: "done" });
    expect(
      await dispatchOfficeTask(
        dispatchDeps({ ...openAnalystTask, assignee_kind: "human" }, runtime),
        { slug: "acme", callerToken: "t", taskId: "office_task:x" },
      ),
    ).toEqual({ kind: "assignee-not-virtual" });
    expect(
      await dispatchOfficeTask(
        dispatchDeps({ ...openAnalystTask, assignee_status: "paused" }, runtime),
        { slug: "acme", callerToken: "t", taskId: "office_task:x" },
      ),
    ).toEqual({ kind: "assignee-inactive", status: "paused" });
    expect(enqueued).toHaveLength(0);
  });

  test("重复派发收敛到同一 office-task 幂等键", async () => {
    const { runtime, enqueued } = fakeRuntime("coalesced");
    const d = dispatchDeps(openAnalystTask, runtime);
    await dispatchOfficeTask(d, { slug: "acme", callerToken: "t", taskId: "office_task:utask_abcd" });
    await dispatchOfficeTask(d, { slug: "acme", callerToken: "t", taskId: "office_task:utask_abcd" });
    const keys = enqueued.map((e) => e.idempotencyKey);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe("office-task:office_task:utask_abcd");
  });
});
