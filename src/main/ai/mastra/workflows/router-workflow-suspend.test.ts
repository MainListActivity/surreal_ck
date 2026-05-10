import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { WorkflowRunState } from "@mastra/core/workflows";

// 共享一个 in-memory storage：跨进程重启场景里，第二个 mastra 实例也复用同一份 workflowRows。
type WorkflowRow = {
  workflow_name: string;
  run_id: string;
  resource_id?: string;
  snapshot: WorkflowRunState;
  status: string;
  created_at: Date;
  updated_at: Date;
};

const workflowRows = new Map<string, WorkflowRow>();
function workflowKey(workflowName: string, runId: string): string {
  return `${workflowName}:${runId}`;
}

mock.module("../../../db/index", () => ({
  getLocalDb: () => ({
    query: async (sql: string, params?: Record<string, unknown>) => {
      if (sql.includes("INSERT INTO mastra_workflow_run")) {
        const content = params?.content as WorkflowRow;
        workflowRows.set(workflowKey(content.workflow_name, content.run_id), content);
        return [[]];
      }
      if (sql.includes("SELECT * FROM mastra_workflow_run") && sql.includes("workflow_name = $workflowName") && sql.includes("run_id = $runId")) {
        const row = workflowRows.get(workflowKey(String(params?.workflowName), String(params?.runId)));
        return [[...(row ? [row] : [])]];
      }
      if (sql.includes("SELECT * FROM mastra_workflow_run") && sql.includes("ORDER BY created_at DESC")) {
        const rows = Array.from(workflowRows.values());
        return [rows, [{ total: rows.length }]];
      }
      if (sql.includes("DELETE mastra_workflow_run") && sql.includes("workflow_name = $workflowName") && sql.includes("run_id = $runId")) {
        workflowRows.delete(workflowKey(String(params?.workflowName), String(params?.runId)));
        return [[]];
      }
      return [[]];
    },
  }),
}));

import { Mastra } from "@mastra/core";
import { RequestContext } from "@mastra/core/request-context";
import { SurrealMastraStore } from "../storage/surreal-store";
import {
  createRouterWorkflow,
  ROUTER_RUNTIME_KEY,
  ROUTER_WORKFLOW_ID,
  type RouterRuntime,
  type SubAgentExecutors,
} from "./router-workflow";
import type { RouterLlmCaller } from "./router-classifier";
import type { AiContextSnapshot } from "../../../../shared/ai-context";

const emptyContext: AiContextSnapshot = {
  route: { screen: "home" },
  workbook: null,
  sheet: null,
  selectedRow: null,
  contextHint: "",
};

function buildMastra() {
  return new Mastra({
    storage: new SurrealMastraStore(),
    workflows: { [ROUTER_WORKFLOW_ID]: createRouterWorkflow() },
  });
}

function makeRuntime(overrides: Partial<RouterRuntime>): RouterRuntime {
  return {
    userContext: emptyContext,
    executors: overrides.executors!,
    llmCaller: overrides.llmCaller!,
    streamId: "stream-1",
    runId: "run-1",
    ...overrides,
  };
}

describe("router workflow suspend & resume", () => {
  beforeEach(() => {
    workflowRows.clear();
  });

  test("executor 返回 suspend.ambiguous 时 workflow 状态为 suspended，候选写入 storage", async () => {
    const llm: RouterLlmCaller = async () =>
      `[{"category":"navigation","taskText":"找张三的债权"}]`;
    const executors: SubAgentExecutors = {
      navigation: async () => ({
        text: "",
        confirmed: {},
        suspend: {
          kind: "ambiguous",
          candidates: [
            { id: "claim:abc", label: "张三 / ZQ-2026-001" },
            { id: "claim:def", label: "张三 / ZQ-2026-002" },
          ],
        },
      }),
      dashboard: async () => ({ text: "x", confirmed: {} }),
      "claim-analysis": async () => ({ text: "x", confirmed: {} }),
      chitchat: async () => ({ text: "x", confirmed: {} }),
    };

    const mastra = buildMastra();
    const wf = mastra.getWorkflow(ROUTER_WORKFLOW_ID);
    const run = await wf.createRun();
    const rc = new RequestContext();
    rc.set(ROUTER_RUNTIME_KEY, makeRuntime({ executors, llmCaller: llm }));

    const result = await run.start({ inputData: { text: "找张三的债权" }, requestContext: rc });

    expect(result.status).toBe("suspended");
    // storage 中能看到该 run，状态为 suspended
    const stored = await new SurrealMastraStore().stores.workflows.getWorkflowRunById({
      workflowName: ROUTER_WORKFLOW_ID,
      runId: run.runId,
    });
    expect(stored).not.toBeNull();
    const snap = stored?.snapshot as { status?: string } | undefined;
    expect(snap?.status).toBe("suspended");
  });

  test("ambiguous candidates > 20 时只暴露前 20 + truncated:true（通过 onSuspend 回调）", async () => {
    const candidates = Array.from({ length: 25 }, (_, i) => ({ id: `r:${i}`, label: `R${i}` }));
    const llm: RouterLlmCaller = async () => `[{"category":"navigation","taskText":"x"}]`;
    const executors: SubAgentExecutors = {
      navigation: async () => ({ text: "", confirmed: {}, suspend: { kind: "ambiguous", candidates } }),
      dashboard: async () => ({ text: "", confirmed: {} }),
      "claim-analysis": async () => ({ text: "", confirmed: {} }),
      chitchat: async () => ({ text: "", confirmed: {} }),
    };

    const events: Array<{ truncated?: boolean; count: number }> = [];
    const mastra = buildMastra();
    const wf = mastra.getWorkflow(ROUTER_WORKFLOW_ID);
    const run = await wf.createRun();
    const rc = new RequestContext();
    rc.set(
      ROUTER_RUNTIME_KEY,
      makeRuntime({
        executors,
        llmCaller: llm,
        onSuspend: (e) => {
          if (e.kind === "ambiguous-candidates") {
            events.push({ truncated: e.truncated, count: e.candidates.length });
          }
        },
      }),
    );

    await run.start({ inputData: { text: "x" }, requestContext: rc });

    expect(events).toEqual([{ truncated: true, count: 20 }]);
  });

  test("resume candidate-chosen 后第二步 executor 看到 confirmed.resolvedRecord", async () => {
    const llm: RouterLlmCaller = async () =>
      `[{"category":"navigation","taskText":"找张三"},{"category":"dashboard","taskText":"对张三做统计"}]`;
    const seen: Array<{ confirmed: unknown; taskText: string }> = [];
    const executors: SubAgentExecutors = {
      navigation: async () => ({
        text: "",
        confirmed: {},
        suspend: {
          kind: "ambiguous",
          candidates: [
            { id: "claim:abc", label: "张三 / ZQ-1" },
            { id: "claim:def", label: "张三 / ZQ-2" },
          ],
        },
      }),
      dashboard: async ({ shared, taskText }) => {
        seen.push({ confirmed: { ...shared.confirmed }, taskText });
        return { text: "已生成草稿", confirmed: {} };
      },
      "claim-analysis": async () => ({ text: "", confirmed: {} }),
      chitchat: async () => ({ text: "", confirmed: {} }),
    };

    const mastra = buildMastra();
    const wf = mastra.getWorkflow(ROUTER_WORKFLOW_ID);
    const run = await wf.createRun();
    const rc = new RequestContext();
    rc.set(ROUTER_RUNTIME_KEY, makeRuntime({ executors, llmCaller: llm }));
    const first = await run.start({ inputData: { text: "..." }, requestContext: rc });
    expect(first.status).toBe("suspended");

    const rc2 = new RequestContext();
    rc2.set(ROUTER_RUNTIME_KEY, makeRuntime({ executors, llmCaller: llm }));
    const resumed = await run.resume({
      resumeData: { decision: { kind: "candidate-chosen", candidateId: "claim:abc" } },
      requestContext: rc2,
    });
    expect(resumed.status).toBe("success");
    expect(seen).toHaveLength(1);
    expect(seen[0].confirmed).toEqual({ resolvedRecord: { id: "claim:abc", label: "张三 / ZQ-1" } });
  });

  test("candidate-cancelled 后续步骤不执行，workflow status=success（已取消）", async () => {
    const llm: RouterLlmCaller = async () =>
      `[{"category":"navigation","taskText":"a"},{"category":"dashboard","taskText":"b"}]`;
    const dashboardCalls: number[] = [];
    const executors: SubAgentExecutors = {
      navigation: async () => ({
        text: "",
        confirmed: {},
        suspend: {
          kind: "ambiguous",
          candidates: [{ id: "x:1", label: "X" }],
        },
      }),
      dashboard: async () => {
        dashboardCalls.push(1);
        return { text: "should-not-run", confirmed: {} };
      },
      "claim-analysis": async () => ({ text: "", confirmed: {} }),
      chitchat: async () => ({ text: "", confirmed: {} }),
    };
    const mastra = buildMastra();
    const wf = mastra.getWorkflow(ROUTER_WORKFLOW_ID);
    const run = await wf.createRun();
    const rc = new RequestContext();
    rc.set(ROUTER_RUNTIME_KEY, makeRuntime({ executors, llmCaller: llm }));
    await run.start({ inputData: { text: "..." }, requestContext: rc });
    const resumed = await run.resume({
      resumeData: { decision: { kind: "candidate-cancelled" } },
    });
    expect(dashboardCalls).toEqual([]);
    expect(["success", "cancelled"]).toContain(resumed.status);
  });

  test("await-write-confirm：plan 末步是写操作时 workflow 进入 suspended 等待确认", async () => {
    const llm: RouterLlmCaller = async () => `[{"category":"dashboard","taskText":"做统计图"}]`;
    const writeIntent = { type: "dashboardDraft" as const, draft: { title: "T" } };
    const executors: SubAgentExecutors = {
      navigation: async () => ({ text: "", confirmed: {} }),
      dashboard: async () => ({
        text: "",
        confirmed: {},
        suspend: { kind: "await-write-confirm", intent: writeIntent },
      }),
      "claim-analysis": async () => ({ text: "", confirmed: {} }),
      chitchat: async () => ({ text: "", confirmed: {} }),
    };

    const mastra = buildMastra();
    const wf = mastra.getWorkflow(ROUTER_WORKFLOW_ID);
    const run = await wf.createRun();
    const rc = new RequestContext();
    rc.set(ROUTER_RUNTIME_KEY, makeRuntime({ executors, llmCaller: llm }));
    const r = await run.start({ inputData: { text: "..." }, requestContext: rc });
    expect(r.status).toBe("suspended");

    const resumed = await run.resume({
      resumeData: { decision: { kind: "write-confirmed" } },
    });
    expect(resumed.status).toBe("success");
  });

  test("resume 写入 confirmed.resolvedRecord 前经过 zod 校验：候选 label 缺失则视为取消", async () => {
    const llm: RouterLlmCaller = async () =>
      `[{"category":"navigation","taskText":"a"},{"category":"dashboard","taskText":"b"}]`;
    const dashCalls: number[] = [];
    const executors: SubAgentExecutors = {
      navigation: async () => ({
        text: "",
        confirmed: {},
        // 故意构造空 label 候选
        suspend: { kind: "ambiguous", candidates: [{ id: "x:1", label: "" } as { id: string; label: string }] },
      }),
      dashboard: async ({ shared }) => {
        dashCalls.push(1);
        return { text: JSON.stringify(shared.confirmed), confirmed: {} };
      },
      "claim-analysis": async () => ({ text: "", confirmed: {} }),
      chitchat: async () => ({ text: "", confirmed: {} }),
    };
    const mastra = buildMastra();
    const wf = mastra.getWorkflow(ROUTER_WORKFLOW_ID);
    const run = await wf.createRun();
    const rc = new RequestContext();
    rc.set(ROUTER_RUNTIME_KEY, makeRuntime({ executors, llmCaller: llm }));
    await run.start({ inputData: { text: "..." }, requestContext: rc });
    const resumed = await run.resume({
      resumeData: { decision: { kind: "candidate-chosen", candidateId: "x:1" } },
    });
    // 第二步未执行 = 校验失败被当作取消
    expect(dashCalls).toEqual([]);
    expect(["success", "cancelled"]).toContain(resumed.status);
  });

  test("跨进程模拟：第一个 mastra 实例 suspend 后丢弃，第二个实例 createRun(runId) + resume 接续", async () => {
    const llm: RouterLlmCaller = async () =>
      `[{"category":"navigation","taskText":"a"},{"category":"dashboard","taskText":"b"}]`;
    const seen: Array<unknown> = [];

    const baseExecutors: SubAgentExecutors = {
      navigation: async () => ({
        text: "",
        confirmed: {},
        suspend: {
          kind: "ambiguous",
          candidates: [
            { id: "claim:abc", label: "张三 / ZQ-1" },
            { id: "claim:def", label: "张三 / ZQ-2" },
          ],
        },
      }),
      dashboard: async ({ shared }) => {
        seen.push({ ...shared.confirmed });
        return { text: "ok", confirmed: {} };
      },
      "claim-analysis": async () => ({ text: "", confirmed: {} }),
      chitchat: async () => ({ text: "", confirmed: {} }),
    };

    // 进程 A：suspend
    const mastraA = buildMastra();
    const runA = await mastraA.getWorkflow(ROUTER_WORKFLOW_ID).createRun();
    const rcA = new RequestContext();
    rcA.set(ROUTER_RUNTIME_KEY, makeRuntime({ executors: baseExecutors, llmCaller: llm }));
    const r1 = await runA.start({ inputData: { text: "..." }, requestContext: rcA });
    expect(r1.status).toBe("suspended");
    const persistedRunId = runA.runId;

    // 进程 B：完全新的 mastra 实例（共享同一个 in-mem workflowRows store mock）
    const mastraB = buildMastra();
    const runB = await mastraB.getWorkflow(ROUTER_WORKFLOW_ID).createRun({ runId: persistedRunId });
    const rcB = new RequestContext();
    rcB.set(ROUTER_RUNTIME_KEY, makeRuntime({ executors: baseExecutors, llmCaller: llm, runId: persistedRunId }));
    const r2 = await runB.resume({
      resumeData: { decision: { kind: "candidate-chosen", candidateId: "claim:abc" } },
      requestContext: rcB,
    });
    expect(r2.status).toBe("success");
    expect(seen).toEqual([{ resolvedRecord: { id: "claim:abc", label: "张三 / ZQ-1" } }]);
  });
});
