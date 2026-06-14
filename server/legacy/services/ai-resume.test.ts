import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { WorkflowRunState } from "@mastra/core/workflows";

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
function key(w: string, r: string) { return `${w}:${r}`; }

mock.module("../db/index", () => ({
  getLocalDb: () => ({
    query: async (sql: string, params?: Record<string, unknown>) => {
      if (sql.includes("INSERT INTO mastra_workflow_run")) {
        const c = params?.content as WorkflowRow;
        workflowRows.set(key(c.workflow_name, c.run_id), c);
        return [[]];
      }
      if (sql.includes("SELECT * FROM mastra_workflow_run") && sql.includes("workflow_name = $workflowName") && sql.includes("run_id = $runId")) {
        const row = workflowRows.get(key(String(params?.workflowName), String(params?.runId)));
        return [[...(row ? [row] : [])]];
      }
      if (sql.includes("SELECT * FROM mastra_workflow_run") && sql.includes("ORDER BY created_at DESC")) {
        const rows = Array.from(workflowRows.values());
        return [rows, [{ total: rows.length }]];
      }
      if (sql.includes("DELETE mastra_workflow_run") && sql.includes("workflow_name = $workflowName") && sql.includes("run_id = $runId")) {
        workflowRows.delete(key(String(params?.workflowName), String(params?.runId)));
        return [[]];
      }
      return [[]];
    },
  }),
}));

import { Mastra } from "@mastra/core";
import { RequestContext } from "@mastra/core/request-context";
import { SurrealMastraStore } from "../ai/mastra/storage/surreal-store";
import {
  createRouterWorkflow,
  ROUTER_RUNTIME_KEY,
  ROUTER_WORKFLOW_ID,
  type RouterRuntime,
  type SubAgentExecutors,
} from "../ai/mastra/workflows/router-workflow";
import type { RouterLlmCaller } from "../ai/mastra/workflows/router-classifier";
import type { AiContextSnapshot } from "../../shared/ai-context";
import { resumeAiWorkflow } from "./ai-resume";

const emptyContext: AiContextSnapshot = {
  route: { screen: "home" },
  workbook: null,
  sheet: null,
  selectedRow: null,
  contextHint: "",
};

function buildMastra() {
  return new Mastra({
    storage: new SurrealMastraStore(() => ({ db: null as never, subject: "user:test" })),
    workflows: { [ROUTER_WORKFLOW_ID]: createRouterWorkflow() },
  });
}

function makeRuntime(executors: SubAgentExecutors, llm: RouterLlmCaller, runId = "x"): RouterRuntime {
  return {
    userContext: emptyContext,
    executors,
    llmCaller: llm,
    streamId: "s",
    runId,
  };
}

describe("resumeAiWorkflow", () => {
  beforeEach(() => {
    workflowRows.clear();
  });

  test("candidate-chosen 通过 storage 找到暂停 run，并把决策写入 confirmed.resolvedRecord", async () => {
    const llm: RouterLlmCaller = async () =>
      `[{"category":"navigation","taskText":"a"},{"category":"dashboard","taskText":"b"}]`;
    const seen: Array<unknown> = [];
    const executors: SubAgentExecutors = {
      navigation: async () => ({
        text: "",
        confirmed: {},
        suspend: { kind: "ambiguous", candidates: [{ id: "claim:abc", label: "L1" }] },
      }),
      dashboard: async ({ shared }) => {
        seen.push({ ...shared.confirmed });
        return { text: "ok", confirmed: {} };
      },
      "claim-analysis": async () => ({ text: "", confirmed: {} }),
      chitchat: async () => ({ text: "", confirmed: {} }),
    };

    // 进程 A：suspend
    const m1 = buildMastra();
    const run = await m1.getWorkflow(ROUTER_WORKFLOW_ID).createRun();
    const rc = new RequestContext();
    rc.set(ROUTER_RUNTIME_KEY, makeRuntime(executors, llm, run.runId));
    const r1 = await run.start({ inputData: { text: "..." }, requestContext: rc });
    expect(r1.status).toBe("suspended");

    // 进程 B：完全独立的 mastra；通过 resumeAiWorkflow 接力
    const m2 = buildMastra();
    const result = await resumeAiWorkflow({
      mastra: m2,
      runId: run.runId,
      decision: { kind: "candidate-chosen", candidateId: "claim:abc" },
      executors,
      llmCaller: llm,
      userContext: emptyContext,
      streamId: "s",
    });

    expect(result.status).toBe("success");
    expect(result.resumed).toBe(true);
    expect(seen).toEqual([{ resolvedRecord: { id: "claim:abc", label: "L1" } }]);
  });

  test("找不到 runId 时返回 resumed=false", async () => {
    const m = buildMastra();
    const result = await resumeAiWorkflow({
      mastra: m,
      runId: "nonexistent",
      decision: { kind: "candidate-cancelled" },
      executors: {
        navigation: async () => ({ text: "", confirmed: {} }),
        dashboard: async () => ({ text: "", confirmed: {} }),
        "claim-analysis": async () => ({ text: "", confirmed: {} }),
        chitchat: async () => ({ text: "", confirmed: {} }),
      },
      llmCaller: async () => "[]",
      userContext: emptyContext,
      streamId: "s",
    });
    expect(result.resumed).toBe(false);
  });
});
