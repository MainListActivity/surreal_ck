/**
 * 服务端写栅栏原语（PG-1）。
 *
 * 这些测试用可控桩替代 SurrealDB，把「exactly-once 消费」的判定逻辑钉死：
 * 第一次确认命中 pending 并执行写；第二次（跨实例 / run 已终态）不写、具名拒绝；
 * 业务写抛错时消费一并回滚，下次仍可重试。
 *
 * 事务回滚语义本身（cancel 撤销已执行 UPDATE）已在本地 fork 上实测，见
 * write-fence.ts 头部注释；这里验证的是「我们怎么用这个语义」。
 */
import { describe, expect, mock, test } from "bun:test";
import { StringRecordId } from "surrealdb";
import { CHAT_WRITE_FENCE_ERRORS } from "@surreal-ck/shared";
import {
  claimSuspendDecision,
  consumeSuspendAndWrite,
  fenceRejected,
  isRunTerminal,
  loadRunFenceState,
  registerSuspendFence,
  releaseSuspendDecision,
  type FenceSession,
} from "./write-fence";

/** 记录调用序列的事务桩：query 返回预置结果，commit/cancel 各自记账。 */
function makeTx(responses: unknown[]) {
  const calls: Array<{ kind: "query"; sql: string; vars: Record<string, unknown> } | "commit" | "cancel"> = [];
  let index = 0;
  return {
    calls,
    tx: {
      async query(sql: string, vars?: Record<string, unknown>) {
        calls.push({ kind: "query", sql, vars: vars ?? {} });
        return responses[index++] ?? [];
      },
      async commit() { calls.push("commit"); },
      async cancel() { calls.push("cancel"); },
    },
  };
}

function makeSession(tx: { query: unknown; commit: unknown; cancel: unknown }) {
  const started: number[] = [];
  const session: FenceSession = {
    async query() { return []; },
    async beginTransaction() {
      started.push(Date.now());
      return tx as never;
    },
  };
  return { session, started };
}

/** 顺序应答的只读会话桩；同时把每次 SQL 记进 `seen` 供断言。 */
function sessionOf(seen: string[], responses: unknown[]) {
  let index = 0;
  return {
    async query(sql: string) {
      seen.push(sql);
      return responses[index++] ?? [];
    },
  };
}

/** SDK 的 `tx.query` 返回 `[[row…]]`（首个语句的行数组）；命中消费时 UPDATE…RETURN AFTER 有行。 */
const consumedHit = [[{ suspend_path: "execute-one#0", status: "consumed" }]];

describe("consumeSuspendAndWrite", () => {
  test("首次确认：消费命中后执行业务写并提交", async () => {
    const { calls, tx } = makeTx([consumedHit]);
    const { session } = makeSession(tx);
    const work = mock(async () => ({ written: { field_1: false }, created: false }));

    const result = await consumeSuspendAndWrite(session, {
      runId: "run-1",
      suspendKey: "execute-one#0",
      decision: "write-confirmed",
      runStatus: "suspended",
      work,
    });

    expect(result).toEqual({ written: { field_1: false }, created: false });
    expect(work).toHaveBeenCalledTimes(1);
    expect(calls.at(-1)).toBe("commit");
    // 消费必须与写同事务：UPDATE 带 status = "pending" 条件，命中才写。
    const consume = calls.find((call) => call !== "commit" && call !== "cancel") as { sql: string; vars: Record<string, unknown> };
    expect(consume.sql).toContain('status = "pending"');
    expect(consume.sql).toContain("owner_user = fn::current_user()");
    expect(consume.vars.suspendKey).toBe("execute-one#0");
  });

  test("二次确认（另一实例）：UPDATE 未命中 → 零写入、回滚、具名 409", async () => {
    const { calls, tx } = makeTx([[]]);
    const base = makeSession(tx);
    const session = {
      ...base.session,
      // 未命中后的区分查询：行存在（已 consumed/resumed）→ consumed
      query: async () => [[{ status: "consumed" }]],
    };
    const work = mock(async () => ({ written: {}, created: false }));

    const error = await consumeSuspendAndWrite(session, {
      runId: "run-1",
      suspendKey: "execute-one#0",
      decision: "write-confirmed",
      runStatus: "suspended",
      work,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as { status: number }).status).toBe(409);
    expect((error as { code: string }).code).toBe(CHAT_WRITE_FENCE_ERRORS.consumed);
    expect(work).not.toHaveBeenCalled();
    expect(calls).toContain("cancel");
    expect(calls).not.toContain("commit");
  });

  test("无此待确认 suspend（键错 / 非写 suspend）：具名 not-pending 拒绝", async () => {
    const { tx } = makeTx([[]]);
    const base = makeSession(tx);
    const session = { ...base.session, query: async () => [[]] };
    const error = await consumeSuspendAndWrite(session, {
      runId: "run-1",
      suspendKey: "execute-one#9",
      decision: "write-confirmed",
      runStatus: "suspended",
      work: async () => ({}),
    }).catch((e) => e);
    expect((error as { code: string }).code).toBe(CHAT_WRITE_FENCE_ERRORS.notPending);
  });

  test("run 已终态时二次确认：具名 run-ended 拒绝（与「已消费」分开）", async () => {
    const { calls, tx } = makeTx([[]]);
    const { session } = makeSession(tx);
    const work = mock(async () => ({ written: {}, created: false }));

    const error = await consumeSuspendAndWrite(session, {
      runId: "run-1",
      suspendKey: "execute-one#0",
      decision: "write-confirmed",
      runStatus: "success",
      work,
    }).catch((e) => e);

    expect((error as { code: string }).code).toBe(CHAT_WRITE_FENCE_ERRORS.runEnded);
    expect(work).not.toHaveBeenCalled();
    expect(calls).not.toContain("commit");
  });

  test("业务写抛错 → 整笔回滚，消费撤销，下次确认仍可重试", async () => {
    const { calls, tx } = makeTx([consumedHit]);
    const { session } = makeSession(tx);

    await consumeSuspendAndWrite(session, {
      runId: "run-1",
      suspendKey: "execute-one#0",
      decision: "write-confirmed",
      runStatus: "suspended",
      work: async () => { throw new Error("写入失败"); },
    }).catch(() => undefined);

    expect(calls).toContain("cancel");
    expect(calls).not.toContain("commit");
  });
});

describe("claimSuspendDecision", () => {
  test("pending → resumed：认领命中并返回原状态", async () => {
    const seen: string[] = [];
    const scoped = sessionOf(seen, [[[{ status: "pending" }]]]);
    const claim = await claimSuspendDecision(scoped, {
      runId: "run-1", suspendKey: "execute-one#0", decision: "write-rejected",
    });
    expect(claim).toEqual({ claimed: true, prevStatus: "pending" });
    // 认领是条件 UPDATE（原子转移），不是「先查后改」。
    expect(seen[0]).toContain('status = "resumed"');
    expect(seen[0]).toContain("suspend_path = $suspendKey");
  });

  test("写已落库（consumed + write-confirmed）的收尾 resume 放行一次", async () => {
    const scoped = sessionOf([], [[[{ status: "consumed", consumed_by: "write-confirmed" }]]]);
    const claim = await claimSuspendDecision(scoped, {
      runId: "run-1", suspendKey: "execute-one#0", decision: "write-confirmed",
    });
    expect(claim).toEqual({ claimed: true, prevStatus: "consumed" });
  });

  test("consumed 上的非 write-confirmed 决策 → 具名 409（确认后不能再忽略）", async () => {
    // 认领 UPDATE 未命中；区分查询显示行已 consumed。
    const scoped = sessionOf([], [[], [[{ status: "consumed" }]]]);
    const error = await claimSuspendDecision(scoped, {
      runId: "run-1", suspendKey: "execute-one#0", decision: "write-rejected",
    }).catch((e) => e);
    expect((error as { status: number }).status).toBe(409);
    expect((error as { code: string }).code).toBe(CHAT_WRITE_FENCE_ERRORS.consumed);
  });

  test("已 resumed 的重放 resume → 具名 409，不静默成功", async () => {
    const scoped = sessionOf([], [[], [[{ status: "resumed" }]]]);
    const error = await claimSuspendDecision(scoped, {
      runId: "run-1", suspendKey: "execute-one#0", decision: "write-confirmed",
    }).catch((e) => e);
    expect((error as { status: number }).status).toBe(409);
    expect((error as { code: string }).code).toBe(CHAT_WRITE_FENCE_ERRORS.consumed);
  });

  test("老 run 无栅栏行：回落 run 状态，终态具名拒绝、非终态放行", async () => {
    // 认领未命中；区分查询无行；run 已终态 → runEnded。
    const terminal = sessionOf([], [[], [], []]);
    const error = await claimSuspendDecision(terminal, {
      runId: "run-1", suspendKey: "execute-one#0", decision: "write-confirmed", runStatus: "success",
    }).catch((e) => e);
    expect((error as { code: string }).code).toBe(CHAT_WRITE_FENCE_ERRORS.runEnded);

    // 无行且 run 未终态 → 放行但不持有认领（claimed=false）。
    const live = sessionOf([], [[], []]);
    await expect(claimSuspendDecision(live, {
      runId: "run-1", suspendKey: "execute-one#0", decision: "write-confirmed", runStatus: "suspended",
    })).resolves.toEqual({ claimed: false });
  });
});

describe("releaseSuspendDecision", () => {
  test("回滚只命中「本次认领置位」的行（resumed + 同 decision）", async () => {
    const seen: string[] = [];
    const scoped = sessionOf(seen, [[[{ status: "resumed" }]]]);
    await releaseSuspendDecision(scoped, {
      runId: "run-1", suspendKey: "execute-one#0", decision: "write-confirmed", prevStatus: "consumed",
    });
    expect(seen[0]).toContain('status = "resumed"');
    expect(seen[0]).toContain("consumed_by = $decision");
  });

  test("无 prevStatus（未认领）时不发任何写", async () => {
    const seen: string[] = [];
    await releaseSuspendDecision(sessionOf(seen, []), {
      runId: "run-1", suspendKey: "execute-one#0", decision: "write-confirmed",
    });
    expect(seen).toHaveLength(0);
  });
});

describe("isRunTerminal", () => {
  test("覆盖成功 / 失败 / 取消三族终态，暂停中不算终态", () => {
    for (const status of ["success", "done", "failed", "cancelled", "canceled"]) {
      expect(isRunTerminal(status)).toBe(true);
    }
    for (const status of ["suspended", "running", "pending", "waiting", ""]) {
      expect(isRunTerminal(status)).toBe(false);
    }
  });
});

describe("registerSuspendFence", () => {
  test("用 ON DUPLICATE KEY UPDATE，且已消费行不会被改回 pending", async () => {
    const seen: string[] = [];
    const scoped = {
      async query(sql: string) { seen.push(sql); return []; },
    } as unknown as Pick<typeof session, "query">;

    await registerSuspendFence(scoped, {
      runId: "run-1",
      suspendKey: "execute-one#0",
      kind: "await-write-confirm",
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("ON DUPLICATE KEY UPDATE");
    // 关键不变量：迟到的重复 suspend 事件不能把已消费的栅栏重开。
    expect(seen[0]).toContain('IF status = "pending"');
  });
});

describe("loadRunFenceState", () => {
  test("从 workflow_run 读状态与当前挂起键；不可见 run 返回 undefined", async () => {
    const responses: unknown[] = [
      [[{ status: "suspended", state: { context: { "execute-one": [{ status: "suspended", suspendPayload: { kind: "ambiguous", suspendKey: "execute-one#3" } }] } } }]],
      [[]],
    ];
    const scoped = { query: async () => responses.shift() ?? [] } as unknown as Pick<typeof session, "query">;

    const state = await loadRunFenceState(scoped, "run-1");
    expect(state).toEqual({ status: "suspended", suspendKey: "execute-one#3" });
    expect(await loadRunFenceState(scoped, "run-2")).toBeUndefined();
  });

  test("查询带 owner 过滤：他人 run 不可见（不泄露存在性）", async () => {
    const seen: string[] = [];
    const scoped = {
      async query(sql: string) { seen.push(sql); return [[]]; },
    } as unknown as Pick<typeof session, "query">;
    await loadRunFenceState(scoped, "run-1");
    expect(seen[0]).toContain("owner_user = fn::current_user()");
    expect(seen[0]).toContain('workflow_name = "routerWorkflow"');
  });
});

describe("fenceRejected", () => {
  test("具名 409 + 稳定 code，供前端按 code 给固定文案", () => {
    for (const code of Object.values(CHAT_WRITE_FENCE_ERRORS)) {
      const error = fenceRejected(code);
      expect(error.status).toBe(409);
      expect(error.code).toBe(code);
    }
  });
});

describe("事务桩自检", () => {
  test("makeTx 按序返回预置结果，调用序列可断言", async () => {
    const { calls, tx } = makeTx([["a"], ["b"]]);
    expect(await tx.query("x")).toEqual(["a"]);
    await tx.commit();
    expect(await tx.query("y")).toEqual(["b"]);
    expect(calls.map((c) => (c === "commit" ? c : c.kind))).toEqual(["query", "commit", "query"]);
    // RecordId 边界：提案 recordId 在 SDK 边界必须包成 StringRecordId。
    expect(String(new StringRecordId("tbl:abc"))).toBe("tbl:abc");
  });
});