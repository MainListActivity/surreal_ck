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
      suspendKey: "execute-one#0",
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
      suspendKey: "execute-one#0",
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

describe("PG-1：recover 还原的卡必须带与原 stream 事件同一个 suspendKey", () => {
  function makeSession(row: unknown) {
    const calls: Array<{ sql: string; params?: Record<string, unknown> }> = [];
    return {
      calls,
      async query(sql: string, params?: Record<string, unknown>) {
        calls.push({ sql, params });
        return [row ? [row] : []];
      },
    };
  }

  function stateWith(payload: Record<string, unknown>, index = 0) {
    return {
      suspendedPaths: { "execute-one": [index] },
      context: {
        "execute-one": {
          status: "suspended",
          suspendPayload: payload,
          suspendedAt: 1,
          foreachIndex: index,
        },
      },
    };
  }

  test("payload 带 suspendKey 时原样带出（与服务端栅栏行、stream 事件同键）", async () => {
    const session = makeSession({
      status: "suspended",
      state: stateWith({ kind: "await-write-confirm", suspendKey: "execute-one#3", intent: proposal }),
    });
    const decision = await loadSuspendedRunDecision(session as never, "run-1");
    expect(decision?.suspended?.suspendKey).toBe("execute-one#3");
  });

  test("同一 run 的第二次暂停还原出的是第二个键（不会被第一张卡吞掉）", async () => {
    const session = makeSession({
      status: "suspended",
      state: stateWith({ kind: "resource-candidates", suspendKey: "execute-one#1", candidates: [] }, 1),
    });
    const decision = await loadSuspendedRunDecision(session as never, "run-1");
    expect(decision?.suspended?.kind).toBe("resource-candidates");
    expect(decision?.suspended?.suspendKey).toBe("execute-one#1");
  });

  test("老快照无 suspendKey：退化出按游标的键，仍可提交决策", async () => {
    const session = makeSession({
      status: "suspended",
      state: stateWith({ kind: "manual-research", sessionId: "s", workspaceId: "w", query: "q", resourceType: "r" }, 2),
    });
    const decision = await loadSuspendedRunDecision(session as never, "run-1");
    expect(decision?.suspended?.suspendKey).toBe("execute-one#2");
  });

  test("run 已非 suspended：只回状态，不还原卡片", async () => {
    const session = makeSession({ status: "success", state: null });
    const decision = await loadSuspendedRunDecision(session as never, "run-1");
    expect(decision).toEqual({ status: "success" });
  });
});
