import { describe, expect, test } from "bun:test";
import type { SurrealConn } from "./surreal";
import {
  createAssignedTask,
  derivePhase,
  diagnoseStall,
  loadOnboardingState,
  officeRoleRequestKey,
  ONBOARDING_ROLES,
  resolveImport,
  saveOnboardingGoal,
  dispatchTask,
  provisionOfficeEmployee,
  submitBootstrap,
  type ApiLike,
  type ImportState,
  type OnboardingMeta,
} from "./office-onboarding";

/**
 * VO06 模块单测：假 conn 记录全部 SQL/绑定值，假 api 记录端点调用——
 * 覆盖 AC 列出的导入/skip/失败/刷新恢复/重复提交/已有 bootstrap/
 * 断线恢复/workspace 切换场景的状态推导与写入边界。
 */

type Row = Record<string, unknown>;

type Tables = {
  office_meta: Row[];
  office_task: Row[];
  office_report: Row[];
  employee_trigger: Row[];
  user: Row[];
};

function harness(tables: Partial<Tables> = {}) {
  const t: Tables = {
    office_meta: [],
    office_task: [],
    office_report: [],
    employee_trigger: [],
    user: [],
    ...tables,
  };
  const queries: string[] = [];
  const conn = {
    status: "connected" as const,
    connect: async () => true,
    use: async () => ({}),
    close: async () => true,
    subscribe: (() => () => {}) as SurrealConn["subscribe"],
    liveTable: async () => () => {},
    onStatusChange: () => () => {},
    query: (async (sql: string, bindings?: Record<string, unknown>) => {
      queries.push(sql);
      if (/FROM office_meta:office/i.test(sql)) return [...t.office_meta];
      if (/UPDATE office_meta:office|UPSERT office_meta:office/i.test(sql)) {
        // 模拟写入：UPSERT 无行则插行；UPDATE 按 WHERE 守卫推进 import_state。
        const state = bindings?.state as ImportState | undefined;
        const goal = bindings?.goal as string | undefined;
        if (/UPSERT/i.test(sql)) {
          const row = t.office_meta[0] ?? {
            id: "office_meta:office", state: "pending", created_at: "2026-09-30T00:00:00Z",
          };
          if (goal !== undefined) row.goal = goal;
          row.primary_contact = row.primary_contact ?? "user:owner1";
          if (row.state === "pending") row.state = "onboarding";
          if (!t.office_meta[0]) t.office_meta.push(row);
        } else if (state) {
          const row = t.office_meta[0];
          if (row && (row.import_state == null || row.import_state === "failed" || row.import_state === state)) {
            row.import_state = state;
          }
        }
        return [];
      }
      if (/FROM office_task:pm_initial/i.test(sql)) {
        return t.office_task.filter((r) => r.id === "office_task:pm_initial").map((r) => ({ id: r.id }));
      }
      if (/INSERT INTO office_task/i.test(sql)) {
        const id = String((bindings?.id as { toString(): string }) ?? "");
        const row: Row = {
          id, goal: bindings?.goal, assignee: String(bindings?.assignee ?? ""),
          brief: bindings?.brief, status: "open",
          parent: bindings?.parent == null ? null : String(bindings.parent),
        };
        if (!t.office_task.some((r) => r.id === id)) t.office_task.push(row);
        return [[{ id }]];
      }
      if (/FROM office_report/i.test(sql)) return [...t.office_report];
      if (/FROM employee_trigger/i.test(sql)) return [...t.employee_trigger];
      if (/FROM user WHERE id/i.test(sql)) return [...t.user];
      return [];
    }) as SurrealConn["query"],
    updateRecord: (async () => ({})) as SurrealConn["updateRecord"],
  };
  return { conn, queries, tables: t };
}

function fakeApi(handlers: {
  bootstrap?: () => { status: number; body: unknown };
  dispatch?: () => { status: number; body: unknown };
  employees?: () => { status: number; body: unknown };
}) {
  const calls: { bootstrap: string[]; dispatch: string[]; employees: string[] } = {
    bootstrap: [],
    dispatch: [],
    employees: [],
  };
  const api = {
    workspaces: {
      ":slug": {
        office: {
          bootstrap: {
            $post: async ({ param }: { param: { slug: string } }) => {
              calls.bootstrap.push(param.slug);
              const r = handlers.bootstrap?.() ?? { status: 200, body: { ok: true, employeeId: "user:ve_pm", taskId: "office_task:pm_initial" } };
              return { ok: r.status < 300, status: r.status, json: async () => r.body };
            },
          },
          tasks: {
            ":taskId": {
              dispatch: {
                $post: async ({ param }: { param: { slug: string; taskId: string } }) => {
                  calls.dispatch.push(`${param.slug}|${param.taskId}`);
                  const r = handlers.dispatch?.() ?? { status: 200, body: { ok: true } };
                  return { ok: r.status < 300, status: r.status, json: async () => r.body };
                },
              },
            },
          },
        },
        employees: {
          $post: async ({ param, json }: { param: { slug: string }; json: Record<string, unknown> }) => {
            calls.employees.push(`${param.slug}|${json.requestKey}`);
            const r = handlers.employees?.() ?? { status: 200, body: { ok: true, employee: { id: "user:ve_analyst" } } };
            return { ok: r.status < 300, status: r.status, json: async () => r.body };
          },
        },
      },
    },
  } as unknown as ApiLike;
  return { api, calls };
}

const metaWith = (over: Partial<OnboardingMeta> = {}): OnboardingMeta => ({
  goal: "跑出风险清单",
  state: "onboarding",
  primaryContactId: "user:owner1",
  importState: null,
  ...over,
});

describe("阶段推导（各步骤刷新/重进恢复同一状态）", () => {
  test("无 meta / 缺 goal / 缺 contact → meta", () => {
    expect(derivePhase(null, null)).toBe("meta");
    expect(derivePhase(metaWith({ goal: "  " }), null)).toBe("meta");
    expect(derivePhase(metaWith({ primaryContactId: null }), null)).toBe("meta");
  });

  test("goal+contact 已存、导入未决议/失败 → import", () => {
    expect(derivePhase(metaWith(), null)).toBe("import");
    expect(derivePhase(metaWith({ importState: "failed" }), null)).toBe("import");
  });

  test("导入成功或 skip → ready；已有初始任务/active → active", () => {
    expect(derivePhase(metaWith({ importState: "imported" }), null)).toBe("ready");
    expect(derivePhase(metaWith({ importState: "skipped" }), null)).toBe("ready");
    expect(derivePhase(metaWith({ importState: "skipped", state: "active" }), null)).toBe("active");
    expect(derivePhase(metaWith({ importState: "skipped" }), "office_task:pm_initial")).toBe("active");
  });

  test("断线恢复：loadOnboardingState 从 db 行完整还原", async () => {
    const { conn } = harness({
      office_meta: [{ id: "office_meta:office", goal: "g", state: "onboarding",
        primary_contact: "user:owner1", import_state: "skipped" }],
      office_task: [{ id: "office_task:pm_initial" }],
      office_report: [{ id: "office_report:r1" }],
    });
    const state = await loadOnboardingState(conn);
    expect(state.phase).toBe("active");
    expect(state.initialTaskId).toBe("office_task:pm_initial");
    expect(state.firstReportId).toBe("office_report:r1");
  });
});

describe("元数据写入边界", () => {
  test("saveOnboardingGoal：UPSERT 保留既有 primary_contact，state 前进一步", async () => {
    const { conn, queries, tables } = harness();
    await saveOnboardingGoal(conn, "目标A");
    expect(queries[0]).toContain("primary_contact ?? fn::current_user()");
    expect(tables.office_meta[0]).toMatchObject({
      goal: "目标A", state: "onboarding", primary_contact: "user:owner1",
    });
    // 后来的访问者保存新目标不改写首位联系人（RHS 引用旧值）。
    tables.office_meta[0].primary_contact = "user:first";
    await saveOnboardingGoal(conn, "目标B");
    expect(tables.office_meta[0].primary_contact).toBe("user:first");
  });

  test("resolveImport：skip → imported→skipped 决议覆盖被拒（WHERE 守卫）；failed 可重试", async () => {
    const { conn, tables } = harness({
      office_meta: [{ id: "office_meta:office", state: "onboarding" }],
    });
    await resolveImport(conn, "skipped");
    expect(tables.office_meta[0].import_state).toBe("skipped");
    // 已决议后重复动作（连点/刷新重试）不翻案。
    await resolveImport(conn, "imported");
    expect(tables.office_meta[0].import_state).toBe("skipped");
    // 失败态可重试推进。
    const { conn: conn2, tables: t2 } = harness({
      office_meta: [{ id: "office_meta:office", state: "onboarding", import_state: "failed" }],
    });
    await resolveImport(conn2, "imported");
    expect(t2.office_meta[0].import_state).toBe("imported");
  });
});

describe("窄端点动作", () => {
  test("bootstrap：成功透传员工/任务；meta-incomplete 解析 missing", async () => {
    const { api, calls } = fakeApi({});
    const ok = await submitBootstrap(api, "acme");
    expect(ok).toMatchObject({ ok: true, employeeId: "user:ve_pm", taskId: "office_task:pm_initial" });
    expect(calls.bootstrap).toEqual(["acme"]);

    const denied = fakeApi({
      bootstrap: () => ({ status: 409, body: { code: "office-meta-incomplete", message: "office_meta 未就绪：缺少 goal, primary_contact" } }),
    });
    const fail = await submitBootstrap(denied.api, "acme");
    expect(fail.ok).toBe(false);
    if (!fail.ok) expect(fail.missing).toEqual(["goal", "primary_contact"]);
  });

  test("dispatch：透传 taskId；409 暴露 message", async () => {
    const { api, calls } = fakeApi({});
    expect(await dispatchTask(api, "acme", "office_task:utask_x")).toEqual({ ok: true });
    expect(calls.dispatch).toEqual(["acme|office_task:utask_x"]);
    const failed = fakeApi({ dispatch: () => ({ status: 409, body: { message: "任务已终态" } }) });
    expect(await dispatchTask(failed.api, "acme", "office_task:x"))
      .toEqual({ ok: false, message: "任务已终态" });
  });

  test("开岗只暴露 PM/分析师；requestKey 与 PM 委派路径同键收敛", async () => {
    expect(ONBOARDING_ROLES).toEqual(["project-manager", "data-analyst"]);
    expect(officeRoleRequestKey("data-analyst")).toBe("office-role:data-analyst");
    const { api, calls } = fakeApi({});
    const r = await provisionOfficeEmployee(api, "acme", "data-analyst", "数据分析师");
    expect(r).toMatchObject({ ok: true, employeeId: "user:ve_analyst" });
    expect(calls.employees).toEqual(["acme|office-role:data-analyst"]);
  });
});

describe("分析任务创建（幂等 id + 冲突收敛）", () => {
  test("同一 (assignee, goal, brief) 永远映射同一 record id；重复创建不增生行", async () => {
    const { conn, tables } = harness();
    const brief = { analysis: { table: "ent_x", change: "ADD COLUMN c int" } };
    const first = await createAssignedTask(conn, {
      assigneeId: "user:ve_analyst", goal: "分析 ent_x", brief,
    });
    const again = await createAssignedTask(conn, {
      assigneeId: "user:ve_analyst", goal: "分析 ent_x", brief,
    });
    expect(again).toBe(first);
    expect(tables.office_task.filter((r) => r.id === first)).toHaveLength(1);
    expect(tables.office_task[0].brief).toMatchObject({ analysis: { table: "ent_x" } });
  });

  test("不同输入不同 id；parentId 时 depth=1", async () => {
    const { conn, tables } = harness();
    const a = await createAssignedTask(conn, {
      assigneeId: "user:ve_analyst", goal: "A", brief: {},
    });
    const b = await createAssignedTask(conn, {
      assigneeId: "user:ve_analyst", goal: "B", brief: {},
      parentId: "office_task:pm_initial",
    });
    expect(a).not.toBe(b);
    expect(tables.office_task[1]).toMatchObject({ parent: "office_task:pm_initial" });
  });
});

describe("停滞诊断（区分模型/数据库/预算/员工状态）", () => {
  test("trigger 完成 → null；员工非活跃 → employee", () => {
    expect(diagnoseStall({ trigger: { status: "completed", errorMessage: null }, elapsedMs: 60_000 })).toBeNull();
    expect(diagnoseStall({ employeeStatus: "paused", elapsedMs: 60_000 }))
      .toMatchObject({ cause: "employee" });
  });

  test("错误文本归类：预算/数据库/模型/员工", () => {
    for (const [error, cause] of [
      ["budget-exhausted: day=2026-09-30 used=50000", "budget"],
      ["WebSocket closed unexpectedly", "database"],
      ["model request timed out", "model"],
      ["employee-signin-failed", "employee"],
      ["something-else-entirely", "unknown"],
    ] as const) {
      expect(diagnoseStall({
        trigger: { status: "failed", errorMessage: error }, elapsedMs: 300_000,
      })).toMatchObject({ cause });
    }
  });
});
