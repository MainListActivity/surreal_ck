import { beforeEach, describe, expect, test } from "bun:test";
import type { WorkflowRunState } from "@mastra/core/workflows";

type WorkflowRow = {
  run_id: string;
  workflow_name: string;
  kind: string;
  state: WorkflowRunState;
  status: string;
};

const workflowRows = new Map<string, WorkflowRow>();

const fakeSession = {
  query: async (sql: string, params?: Record<string, unknown>) => {
    if (sql.includes("INSERT INTO workflow_run") || sql.includes("UPSERT") || sql.includes("UPDATE workflow_run")) {
      const content = params?.content as Partial<WorkflowRow> | undefined;
      if (content?.run_id) {
        const existing = workflowRows.get(content.run_id);
        workflowRows.set(content.run_id, {
          run_id: content.run_id,
          workflow_name: content.workflow_name ?? existing?.workflow_name ?? "",
          kind: content.kind ?? existing?.kind ?? "router",
          state: content.state ?? existing?.state ?? ({} as WorkflowRunState),
          status: content.status ?? existing?.status ?? "running",
        });
      }
      return [[]];
    }
    if (sql.includes("SELECT") && sql.includes("FROM workflow_run")) {
      const row = workflowRows.get(String(params?.runId));
      return [row ? [row] : []];
    }
    return [[]];
  },
};
const getSession = () => ({ db: fakeSession as never, subject: "user:test" });

import { Mastra } from "@mastra/core";
import { RequestContext } from "@mastra/core/request-context";
import type { Surreal } from "surrealdb";
import { SurrealMastraStore } from "../storage/surreal-store";
import { setExecutionContext } from "../execution-context";
import { runBoundedTool } from "../tools/bounded-tool";
import { attachRunDiagnostics } from "../../../src/ai/caller-session";
import {
  AiCallerQueryTimeoutError,
  AiRunCancelledError,
  createRunDiagnostics,
  type RunDiagnostics,
} from "../../../src/ai/run-diagnostics";
import {
  createRouterWorkflow,
  ROUTER_RUNTIME_KEY,
  ROUTER_WORKFLOW_ID,
  type RouterRuntime,
  type SubAgentExecutors,
} from "./router-workflow";
import type { RouterLlmCaller } from "./router-classifier";
import type { AiContextSnapshot } from "@surreal-ck/shared";

const emptyContext: AiContextSnapshot = {
  route: { screen: "home" },
  workbook: null,
  sheet: null,
  selectedRow: null,
  contextHint: "",
};

function buildMastra() {
  return new Mastra({
    storage: new SurrealMastraStore(getSession),
    workflows: { [ROUTER_WORKFLOW_ID]: createRouterWorkflow() },
  });
}

const navPlan: RouterLlmCaller = async () => `[{"category":"navigation","taskText":"找记录"}]`;

function executorsWith(navigation: SubAgentExecutors["navigation"]): SubAgentExecutors {
  return {
    navigation,
    dashboard: async () => ({ text: "x", confirmed: {} }),
    "row-analysis": async () => ({ text: "x", confirmed: {} }),
    chitchat: async () => ({ text: "x", confirmed: {} }),
  };
}

function makeRuntime(overrides: Partial<RouterRuntime>): RouterRuntime {
  return {
    userContext: emptyContext,
    surrealSession: { query: async () => [] } as never,
    executors: overrides.executors!,
    llmCaller: overrides.llmCaller ?? navPlan,
    streamId: "stream-1",
    runId: "run-1",
    ...overrides,
  };
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function storedStatus(runId: string): Promise<string | undefined> {
  const stored = await new SurrealMastraStore(getSession).stores.workflows.getWorkflowRunById({
    workflowName: ROUTER_WORKFLOW_ID,
    runId,
  });
  return (stored?.snapshot as { status?: string } | undefined)?.status;
}

describe("PG-1：workflow 级取消与停滞防护", () => {
  beforeEach(() => {
    workflowRows.clear();
  });

  test("executor 在 abort 后拒绝：run 收尾非 suspended；executor op 记 cancelled，已完成 classify 保留", async () => {
    const diag: RunDiagnostics = createRunDiagnostics();
    const session = attachRunDiagnostics({ query: async () => [] } as unknown as Surreal, diag);

    let executorEntered!: () => void;
    const entered = new Promise<void>((resolve) => { executorEntered = resolve; });
    const executors = executorsWith(async (input) => {
      executorEntered();
      // 模拟 provider 在 run 取消时的 abort：abortSignal 触发后拒绝。
      await new Promise<never>((_, reject) => {
        input.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
        setTimeout(() => reject(new DOMException("The operation was aborted.", "AbortError")), 2000);
      });
      return { text: "x", confirmed: {} };
    });

    const mastra = buildMastra();
    const wf = mastra.getWorkflow(ROUTER_WORKFLOW_ID);
    const run = await wf.createRun();
    diag.bindRun({ runId: run.runId, signal: run.abortController.signal, cancelRun: () => { void run.cancel(); } });

    const rc = new RequestContext();
    rc.set(ROUTER_RUNTIME_KEY, makeRuntime({ executors, surrealSession: session }));

    const startPromise = run.start({ inputData: { text: "找记录" }, requestContext: rc });
    await entered;
    await run.cancel();
    const result = await startPromise;

    expect(result.status).not.toBe("suspended");
    expect(result.status).not.toBe("success");

    const snap = diag.snapshot("cancelled");
    expect(snap.aborted).toBe(true);
    const classifyOp = snap.completed.find((op) => op.name === "classify");
    const executorOp = snap.completed.find((op) => op.name === "navigationAgent");
    expect(classifyOp?.status).toBe("ok");
    expect(executorOp?.phase).toBe("executor");
    expect(executorOp?.status).toBe("cancelled");
  });

  test("迟到 suspend 结果：取消后返回挂起信号不得再落挂起态/发确认卡", async () => {
    const diag = createRunDiagnostics();
    const session = attachRunDiagnostics({ query: async () => [] } as unknown as Surreal, diag);
    const suspendEvents: string[] = [];

    let executorEntered!: () => void;
    const entered = new Promise<void>((resolve) => { executorEntered = resolve; });
    const executors = executorsWith(async (input) => {
      executorEntered();
      // 等 run 取消后再「返回」suspend——迟到结果不得推进状态。
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 2000);
      });
      return {
        text: "",
        confirmed: {},
        suspend: {
          kind: "await-write-confirm",
          intent: {
            type: "row-patch-proposal",
            sheetId: "sheet:s",
            recordId: "ent:r",
            proposals: [{ field: "f", currentValue: 1, suggestedValue: 2, basis: "b", confidence: "high" }],
          },
        },
      };
    });

    const mastra = buildMastra();
    const wf = mastra.getWorkflow(ROUTER_WORKFLOW_ID);
    const run = await wf.createRun();
    diag.bindRun({ runId: run.runId, signal: run.abortController.signal, cancelRun: () => { void run.cancel(); } });

    const rc = new RequestContext();
    rc.set(ROUTER_RUNTIME_KEY, makeRuntime({
      executors,
      surrealSession: session,
      onSuspend: (e) => suspendEvents.push(e.kind),
    }));

    const startPromise = run.start({ inputData: { text: "找记录" }, requestContext: rc });
    await entered;
    await run.cancel();
    const result = await startPromise;

    expect(result.status).not.toBe("suspended");
    expect(result.status).not.toBe("success");
    expect(suspendEvents).toEqual([]);
    expect(await storedStatus(run.runId)).not.toBe("suspended");
  });

  test("永不返回的 tool 在时限内超出名失败：diag.fatal + cancelRun 触发 run 取消", async () => {
    const diag = createRunDiagnostics({ toolTimeoutMs: 30 });
    const session = attachRunDiagnostics({ query: async () => [] } as unknown as Surreal, diag);

    const executors = executorsWith(async (input) => {
      const toolRc = new RequestContext();
      setExecutionContext(toolRc, { surrealSession: session });
      // 模拟 tool 内部永不返回：runBoundedTool 的时限兜底要兜住。
      await runBoundedTool("analyzeRow", { requestContext: toolRc, abortSignal: input.signal },
        () => new Promise(() => {}));
      return { text: "x", confirmed: {} };
    });

    const mastra = buildMastra();
    const wf = mastra.getWorkflow(ROUTER_WORKFLOW_ID);
    const run = await wf.createRun();
    diag.bindRun({ runId: run.runId, signal: run.abortController.signal, cancelRun: () => { void run.cancel(); } });

    const rc = new RequestContext();
    rc.set(ROUTER_RUNTIME_KEY, makeRuntime({ executors, surrealSession: session }));

    const startedAt = Date.now();
    const result = await run.start({ inputData: { text: "找记录" }, requestContext: rc });
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(result.status).not.toBe("success");
    expect(result.status).not.toBe("suspended");

    expect(diag.fatalError).toBeInstanceOf(Error);
    const snap = diag.snapshot("failed");
    expect(snap.fatalError).toBe("ai-tool-timeout");
    expect(snap.aborted).toBe(true); // fatal → cancelRun → run 信号触发
    const executorOp = snap.completed.find((op) => op.name === "navigationAgent");
    expect(executorOp?.status).toBe("timeout");
    expect(executorOp?.error).toBe("ai-tool-timeout");
  });

  test("上游 signal abort：在途 executor op 立刻记 cancelled，不等执行体返回", async () => {
    const diag = createRunDiagnostics();
    const session = attachRunDiagnostics({ query: async () => [] } as unknown as Surreal, diag);
    const callerAbort = new AbortController();

    let executorEntered!: () => void;
    const entered = new Promise<void>((resolve) => { executorEntered = resolve; });
    const executors = executorsWith(async (input) => {
      executorEntered();
      // 永不返回，由 run.cancel（经上游信号联动）收尾。
      await new Promise<never>((_, reject) => {
        input.signal?.addEventListener("abort", () => reject(new AiRunCancelledError()), { once: true });
        setTimeout(() => reject(new AiRunCancelledError()), 2000);
      });
      return { text: "x", confirmed: {} };
    });

    const mastra = buildMastra();
    const wf = mastra.getWorkflow(ROUTER_WORKFLOW_ID);
    const run = await wf.createRun();
    diag.bindRun({
      runId: run.runId,
      signal: callerAbort.signal,
      cancelRun: () => { void run.cancel(); },
    });
    // 上游 signal 触发时联动 run.cancel（与 router-chat.ts 的绑定一致）。
    callerAbort.signal.addEventListener("abort", () => { void run.cancel(); }, { once: true });

    const rc = new RequestContext();
    rc.set(ROUTER_RUNTIME_KEY, makeRuntime({ executors, surrealSession: session }));

    const startPromise = run.start({ inputData: { text: "找记录" }, requestContext: rc });
    await entered;
    callerAbort.abort();
    await tick(0);
    // 取消后马上读快照：在途 executor op 已被记 cancelled（不要求等它返回）。
    const mid = diag.snapshot("cancelled");
    expect(mid.aborted).toBe(true);
    expect(mid.completed.find((op) => op.name === "navigationAgent")?.status).toBe("cancelled");
    const result = await startPromise;
    expect(result.status).not.toBe("suspended");
    expect(result.status).not.toBe("success");
  });

  test("业务失败（非超时）不置 fatal：按原错误收尾", async () => {
    const diag = createRunDiagnostics();
    const session = attachRunDiagnostics({ query: async () => [] } as unknown as Surreal, diag);
    const executors = executorsWith(async () => {
      throw new AiCallerQueryTimeoutError("query");
    });
    void executors;
    const failing = executorsWith(async () => { throw new Error("表结构读取失败"); });

    const mastra = buildMastra();
    const wf = mastra.getWorkflow(ROUTER_WORKFLOW_ID);
    const run = await wf.createRun();
    diag.bindRun({ runId: run.runId, signal: run.abortController.signal, cancelRun: () => { void run.cancel(); } });

    const rc = new RequestContext();
    rc.set(ROUTER_RUNTIME_KEY, makeRuntime({ executors: failing, surrealSession: session }));

    const result = await run.start({ inputData: { text: "找记录" }, requestContext: rc });
    expect(result.status).not.toBe("success");
    expect(diag.fatalError).toBeUndefined();
    const snap = diag.snapshot("failed");
    expect(snap.completed.find((op) => op.name === "navigationAgent")?.status).toBe("failed");
  });
});
