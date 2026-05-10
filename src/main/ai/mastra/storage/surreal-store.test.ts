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
let failWrites = false;

function workflowKey(workflowName: string, runId: string): string {
  return `${workflowName}:${runId}`;
}

mock.module("../../../db/index", () => ({
  getLocalDb: () => ({
    query: async (sql: string, params?: Record<string, unknown>) => {
      if (sql.includes("INSERT INTO mastra_workflow_run")) {
        if (failWrites) throw new Error("db unavailable");
        const content = params?.content as WorkflowRow;
        workflowRows.set(workflowKey(content.workflow_name, content.run_id), content);
        return [[]];
      }
      if (sql.includes("SELECT * FROM mastra_workflow_run") && sql.includes("workflow_name = $workflowName") && sql.includes("run_id = $runId")) {
        const row = workflowRows.get(workflowKey(String(params?.workflowName), String(params?.runId)));
        return [[...(row ? [row] : [])]];
      }
      if (sql.includes("SELECT * FROM mastra_workflow_run") && sql.includes("ORDER BY created_at DESC")) {
        let rows = Array.from(workflowRows.values());
        if (sql.includes("workflow_name = $workflowName")) {
          rows = rows.filter((row) => row.workflow_name === params?.workflowName);
        }
        rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
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

function snapshot(runId: string): WorkflowRunState {
  return {
    runId,
    status: "suspended",
    value: {},
    context: {
      input: { prompt: "打开合同管理工作簿" },
      "pick-workbook": {
        status: "suspended",
        payload: { query: "合同管理" },
        startedAt: 1_772_000_000_000,
        suspendedAt: 1_772_000_001_000,
      },
    } as unknown as WorkflowRunState["context"],
    serializedStepGraph: [],
    activePaths: [],
    activeStepsPath: {},
    suspendedPaths: { "pick-workbook": [0] },
    resumeLabels: { choose: { stepId: "pick-workbook" } },
    waitingPaths: {},
    timestamp: 1_772_000_000_000,
  };
}

describe("SurrealWorkflowsStorage", () => {
  beforeEach(() => {
    workflowRows.clear();
    failWrites = false;
  });

  test("persistWorkflowSnapshot 后可以 loadWorkflowSnapshot 读回同一个 workflow 暂停态", async () => {
    const { SurrealWorkflowsStorage } = await import("./surreal-store");
    const storage = new SurrealWorkflowsStorage();
    const state = snapshot("run-special/chars");

    await storage.persistWorkflowSnapshot({
      workflowName: "router",
      runId: "run-special/chars",
      resourceId: "user:local",
      snapshot: state,
      createdAt: new Date("2026-05-09T08:00:00.000Z"),
      updatedAt: new Date("2026-05-09T08:01:00.000Z"),
    });

    await expect(storage.loadWorkflowSnapshot({ workflowName: "router", runId: "run-special/chars" })).resolves.toEqual(state);
  });

  test("listWorkflowRuns 支持按 workflowName 过滤", async () => {
    const { SurrealWorkflowsStorage } = await import("./surreal-store");
    const storage = new SurrealWorkflowsStorage();

    await storage.persistWorkflowSnapshot({
      workflowName: "router",
      runId: "router-run",
      snapshot: snapshot("router-run"),
      createdAt: new Date("2026-05-09T08:00:00.000Z"),
    });
    await storage.persistWorkflowSnapshot({
      workflowName: "other",
      runId: "other-run",
      snapshot: snapshot("other-run"),
      createdAt: new Date("2026-05-09T09:00:00.000Z"),
    });

    const result = await storage.listWorkflowRuns({ workflowName: "router" });

    expect(result.total).toBe(1);
    expect(result.runs.map((run) => run.runId)).toEqual(["router-run"]);
    expect(result.runs[0]?.workflowName).toBe("router");
  });

  test("deleteWorkflowRunById 删除后 loadWorkflowSnapshot 返回 null", async () => {
    const { SurrealWorkflowsStorage } = await import("./surreal-store");
    const storage = new SurrealWorkflowsStorage();

    await storage.persistWorkflowSnapshot({
      workflowName: "router",
      runId: "run-to-delete",
      snapshot: snapshot("run-to-delete"),
    });

    await storage.deleteWorkflowRunById({ workflowName: "router", runId: "run-to-delete" });

    await expect(storage.loadWorkflowSnapshot({ workflowName: "router", runId: "run-to-delete" })).resolves.toBeNull();
  });

  test("写入失败被 catch，不抛到 workflow 引擎层", async () => {
    const { SurrealWorkflowsStorage } = await import("./surreal-store");
    const storage = new SurrealWorkflowsStorage();
    failWrites = true;

    await expect(storage.persistWorkflowSnapshot({
      workflowName: "router",
      runId: "degraded-run",
      snapshot: snapshot("degraded-run"),
    })).resolves.toBeUndefined();
  });
});
