import { describe, expect, test } from "bun:test";
import { extractSuspendedPayload, loadSuspendedRunDecision } from "./suspend-recovery";

const proposal = {
  type: "row-patch-proposal" as const,
  sheetId: "sheet:items",
  recordId: "ent_items:one",
  proposals: [
    { field: "amount", currentValue: 100, suggestedValue: 250, basis: "依据巡检附件二", confidence: "high" as const },
  ],
};

function makeSession(row: unknown) {
  const calls: Array<{ sql: string; params?: Record<string, unknown> }> = [];
  return {
    calls,
    async query(sql: string, params?: Record<string, unknown>) {
      calls.push({ sql, params });
      if (sql.includes("FROM workflow_run")) return [row ? [row] : []];
      return [[]];
    },
  };
}

describe("extractSuspendedPayload", () => {
  test("从 suspendedPaths 定位的 dountil 数组形态中取最近一条 suspended", () => {
    const state = {
      suspendedPaths: { "execute-one": [1] },
      context: {
        "execute-one": [
          { status: "suspended", suspendPayload: { kind: "ambiguous", candidates: [] }, suspendedAt: 10 },
          { status: "suspended", suspendPayload: { kind: "await-write-confirm", intent: proposal }, suspendedAt: 20 },
        ],
      },
    };
    expect(extractSuspendedPayload(state)).toEqual({ kind: "await-write-confirm", intent: proposal });
  });

  test("suspendedPaths 缺失时退回全量扫描，跳过非 suspended 步骤", () => {
    const state = {
      context: {
        classify: { status: "success", payload: { plan: [] } },
        "execute-one": { status: "suspended", suspendPayload: { kind: "await-write-confirm", intent: proposal }, suspendedAt: 5 },
      },
    };
    expect(extractSuspendedPayload(state)).toEqual({ kind: "await-write-confirm", intent: proposal });
  });

  test("没有 suspended step 或无 suspendPayload 时返回 undefined", () => {
    expect(extractSuspendedPayload({ context: { "execute-one": { status: "success" } } })).toBeUndefined();
    expect(extractSuspendedPayload({ context: {} })).toBeUndefined();
    expect(extractSuspendedPayload(undefined)).toBeUndefined();
    expect(extractSuspendedPayload({})).toBeUndefined();
  });
});

describe("loadSuspendedRunDecision", () => {
  const suspendedRow = {
    status: "suspended",
    state: {
      suspendedPaths: { "execute-one": [0] },
      context: {
        "execute-one": {
          status: "suspended",
          suspendPayload: { kind: "await-write-confirm", intent: proposal },
          suspendedAt: 1,
        },
      },
    },
  };

  test("suspended run：返回 WorkflowSuspendedEvent 形态的可渲染载荷", async () => {
    const session = makeSession(suspendedRow);
    const decision = await loadSuspendedRunDecision(session as never, "run-1");
    expect(decision?.status).toBe("suspended");
    expect(decision?.suspended).toEqual({
      kind: "await-write-confirm",
      runId: "run-1",
      intent: proposal,
    });
    // owner 谓词随调用者 session 生效，防跨用户读他人 run。
    expect(session.calls[0]?.sql).toContain("owner_user = fn::current_user()");
    expect(session.calls[0]?.params?.runId).toBe("run-1");
  });

  test("ambiguous 持久载荷映射成 ambiguous-candidates 事件", async () => {
    const session = makeSession({
      status: "suspended",
      state: {
        context: {
          "execute-one": {
            status: "suspended",
            suspendPayload: { kind: "ambiguous", candidates: [{ id: "r:1", label: "A" }], truncated: false },
            suspendedAt: 1,
          },
        },
      },
    });
    const decision = await loadSuspendedRunDecision(session as never, "run-9");
    expect(decision?.suspended).toEqual({
      kind: "ambiguous-candidates",
      runId: "run-9",
      candidates: [{ id: "r:1", label: "A" }],
      truncated: undefined,
    });
  });

  test("run 已不在 suspended（已 resume 在跑 / 已完成）：返回状态不附带载荷", async () => {
    for (const status of ["running", "success", "failed", "canceled"]) {
      const session = makeSession({ status, state: suspendedRow.state });
      const decision = await loadSuspendedRunDecision(session as never, "run-1");
      expect(decision?.status).toBe(status);
      expect(decision?.suspended).toBeUndefined();
    }
  });

  test("suspended 但载荷无法映射为已知决策事件：不附带载荷，交由调用方 409", async () => {
    const session = makeSession({
      status: "suspended",
      state: { context: { "execute-one": { status: "suspended", suspendPayload: { kind: "unknown-kind" }, suspendedAt: 1 } } },
    });
    const decision = await loadSuspendedRunDecision(session as never, "run-1");
    expect(decision?.status).toBe("suspended");
    expect(decision?.suspended).toBeUndefined();
  });

  test("调用者不可见 / 不存在的 run：返回 undefined", async () => {
    const session = makeSession(undefined);
    expect(await loadSuspendedRunDecision(session as never, "run-x")).toBeUndefined();
  });
});
