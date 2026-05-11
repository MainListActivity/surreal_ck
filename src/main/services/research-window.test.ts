import { describe, expect, test } from "bun:test";
import {
  cancelResearchSessionForClosedWindow,
  createResearchWindowService,
  isAllowedResearchUrl,
  type ResearchWindowParams,
} from "./research-window";

describe("research window shell", () => {
  test("只允许 http/https URL 和标准裸域名导航", () => {
    expect(isAllowedResearchUrl("https://example.com/a")).toBe(true);
    expect(isAllowedResearchUrl("http://example.com/a")).toBe(true);
    expect(isAllowedResearchUrl("example.com")).toBe(true);
    expect(isAllowedResearchUrl("example")).toBe(false);
    expect(isAllowedResearchUrl("file:///tmp/a.html")).toBe(false);
    expect(isAllowedResearchUrl("views://mainview/index.html")).toBe(false);
    expect(isAllowedResearchUrl("javascript:alert(1)")).toBe(false);
  });

  test("openResearchWindow 根据 sessionId 传递正确参数并返回 session 状态", async () => {
    const opened: ResearchWindowParams[] = [];
    const service = createResearchWindowService({
      getResearchSession: async ({ sessionId }) => ({
        session: {
          id: sessionId,
          workspaceId: "workspace:demo",
          query: "查找合同解除案例",
          context: { selectedRow: { id: "case:1" } },
          resourceType: "generic_note",
          status: "open",
          resourceIds: [],
          createdBy: "app_user:u1",
          createdAt: "2026-05-11T08:00:00.000Z",
          updatedAt: "2026-05-11T08:00:00.000Z",
        },
      }),
      openWindow: async (params) => {
        opened.push(params);
      },
    });

    const result = await service.openResearchWindow({
      sessionId: "research_session:s1",
      initialUrl: "https://example.com/search?q=case",
    });

    expect(opened).toEqual([
      {
        sessionId: "research_session:s1",
        resourceType: "generic_note",
        initialUrl: "https://example.com/search?q=case",
      },
    ]);
    expect(result.session).toMatchObject({
      id: "research_session:s1",
      query: "查找合同解除案例",
      resourceType: "generic_note",
      status: "open",
    });
  });

  test("openResearchWindow 会把裸域名 initialUrl 归一化为 https URL", async () => {
    const opened: ResearchWindowParams[] = [];
    const service = createResearchWindowService({
      getResearchSession: async () => {
        throw new Error("proactive mode should not load session");
      },
      openWindow: async (params) => {
        opened.push(params);
      },
    });

    await service.openResearchWindow({ resourceType: "web_article", initialUrl: "example.com" });

    expect(opened).toEqual([{ resourceType: "web_article", initialUrl: "https://example.com/" }]);
  });

  test("openResearchWindow 支持无 session 的主动补库窗口", async () => {
    const opened: ResearchWindowParams[] = [];
    const service = createResearchWindowService({
      getResearchSession: async () => {
        throw new Error("proactive mode should not load session");
      },
      openWindow: async (params) => {
        opened.push(params);
      },
    });

    const result = await service.openResearchWindow({ resourceType: "generic_note" });

    expect(opened).toEqual([{ resourceType: "generic_note" }]);
    expect(result).toEqual({ opened: true });
  });

  test("关闭手工检索窗口会取消 open session 并通知对应 AI run", async () => {
    const cancelledRuns: Array<{ runId: string; sessionId: string; reason: string }> = [];
    const notified: unknown[] = [];

    const event = await cancelResearchSessionForClosedWindow("research_session:s1", {
      getResearchSession: async () => ({
        session: {
          id: "research_session:s1",
          workspaceId: "workspace:demo",
          originatingRunId: "run-1",
          query: "查找合同解除案例",
          context: {},
          resourceType: "generic_note",
          status: "open",
          resourceIds: [],
          createdBy: "app_user:u1",
          createdAt: "2026-05-11T08:00:00.000Z",
          updatedAt: "2026-05-11T08:00:00.000Z",
        },
      }),
      cancelAiWorkflowRun: async (req) => {
        cancelledRuns.push(req);
        return {
          event: {
            runId: req.runId,
            sessionId: req.sessionId,
            reason: req.reason,
            message: "人工检索窗口已关闭，本次资源搜索已终止。",
          },
        };
      },
      notify: async (payload) => {
        notified.push(payload);
      },
    });

    expect(cancelledRuns).toEqual([{
      runId: "run-1",
      sessionId: "research_session:s1",
      reason: "research-window-closed",
    }]);
    expect(notified).toEqual([event]);
  });

  test("关闭已完成的手工检索窗口不会取消 AI run", async () => {
    const cancelledRuns: unknown[] = [];
    const event = await cancelResearchSessionForClosedWindow("research_session:s1", {
      getResearchSession: async () => ({
        session: {
          id: "research_session:s1",
          workspaceId: "workspace:demo",
          originatingRunId: "run-1",
          query: "查找合同解除案例",
          context: {},
          resourceType: "generic_note",
          status: "completed",
          resourceIds: [],
          createdBy: "app_user:u1",
          createdAt: "2026-05-11T08:00:00.000Z",
          updatedAt: "2026-05-11T08:00:00.000Z",
        },
      }),
      cancelAiWorkflowRun: async (req) => {
        cancelledRuns.push(req);
        throw new Error("不应取消已完成 session");
      },
      notify: async () => {
        throw new Error("不应通知");
      },
    });

    expect(event).toBeNull();
    expect(cancelledRuns).toEqual([]);
  });
});
