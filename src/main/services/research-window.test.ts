import { describe, expect, test } from "bun:test";
import {
  createResearchWindowService,
  isAllowedResearchUrl,
  type ResearchWindowParams,
} from "./research-window";

describe("research window shell", () => {
  test("V1 只允许 http/https 导航", () => {
    expect(isAllowedResearchUrl("https://example.com/a")).toBe(true);
    expect(isAllowedResearchUrl("http://example.com/a")).toBe(true);
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
});
