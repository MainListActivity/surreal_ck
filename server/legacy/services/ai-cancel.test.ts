import { describe, expect, test } from "bun:test";
import { ROUTER_WORKFLOW_ID } from "../ai/mastra/workflows/router-workflow";
import { cancelAiWorkflowRun } from "./ai-cancel";
import type { ResearchSessionResponse } from "../../shared/rpc.types";

function session(status: "open" | "completed" | "cancelled"): ResearchSessionResponse {
  return {
    session: {
      id: "research_session:s1",
      workspaceId: "workspace:demo",
      originatingRunId: "run-1",
      query: "查找审判案例",
      context: {},
      resourceType: "generic_note",
      status,
      resourceIds: [],
      createdBy: "app_user:u1",
      createdAt: "2026-05-11T08:00:00.000Z",
      updatedAt: "2026-05-11T08:00:00.000Z",
    },
  };
}

describe("cancelAiWorkflowRun", () => {
  test("用户终止 AI 运行时删除 workflow run，并取消 open research session", async () => {
    const cancelledSessions: string[] = [];
    const deletedRuns: Array<{ workflowName: string; runId: string }> = [];

    const result = await cancelAiWorkflowRun({
      runId: "run-1",
      sessionId: "research_session:s1",
      reason: "user-cancelled",
    }, {
      getResearchSession: async () => session("open"),
      cancelResearchSession: async ({ sessionId }) => {
        cancelledSessions.push(sessionId);
        return session("cancelled");
      },
      deleteWorkflowRun: async (req) => {
        deletedRuns.push(req);
      },
    });

    expect(cancelledSessions).toEqual(["research_session:s1"]);
    expect(deletedRuns).toEqual([{ workflowName: ROUTER_WORKFLOW_ID, runId: "run-1" }]);
    expect(result.event).toEqual({
      runId: "run-1",
      sessionId: "research_session:s1",
      reason: "user-cancelled",
      message: "本次 AI 操作已终止。",
    });
  });

  test("研究窗口关闭时已完成的 session 不再取消，只通知对应 run", async () => {
    const cancelledSessions: string[] = [];
    const deletedRuns: string[] = [];

    const result = await cancelAiWorkflowRun({
      runId: "run-1",
      sessionId: "research_session:s1",
      reason: "research-window-closed",
    }, {
      getResearchSession: async () => session("completed"),
      cancelResearchSession: async ({ sessionId }) => {
        cancelledSessions.push(sessionId);
        return session("cancelled");
      },
      deleteWorkflowRun: async ({ runId }) => {
        deletedRuns.push(runId);
      },
    });

    expect(cancelledSessions).toEqual([]);
    expect(deletedRuns).toEqual(["run-1"]);
    expect(result.event.message).toBe("人工检索窗口已关闭，本次资源搜索已终止。");
  });
});
