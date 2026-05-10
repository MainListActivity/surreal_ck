import { describe, expect, test } from "bun:test";

describe("navigation agent 注册", () => {
  test("navigationAgent 文件导出一个 Agent 实例", async () => {
    const { navigationAgent } = await import("./mastra/agents/navigation-agent");
    expect(navigationAgent).toBeDefined();
    expect(typeof navigationAgent.generate).toBe("function");
    expect(typeof navigationAgent.stream).toBe("function");
  });

  test("createNavigationAgent 工厂存在", async () => {
    const mod = await import("./mastra/agents/navigation-agent");
    expect(typeof mod.createNavigationAgent).toBe("function");
    expect(typeof mod.NAVIGATION_AGENT_ID).toBe("string");
  });

  test("挂载 issue 04 的 4 个 nav tool", async () => {
    const { NAVIGATION_TOOLS } = await import("./mastra/agents/navigation-agent");
    expect(Object.keys(NAVIGATION_TOOLS).sort()).toEqual(
      ["navigateTool", "searchDashboardTool", "searchRecordTool", "searchWorkbookTool"],
    );
    expect(NAVIGATION_TOOLS.navigateTool.id).toBe("navigate");
    expect(NAVIGATION_TOOLS.searchWorkbookTool.id).toBe("searchWorkbook");
    expect(NAVIGATION_TOOLS.searchDashboardTool.id).toBe("searchDashboard");
    expect(NAVIGATION_TOOLS.searchRecordTool.id).toBe("searchRecord");
  });

  test("src/main/ai/index.ts 导出 navigationAgent 工厂，且不再导出 workspaceAgent", async () => {
    const aiIndex = await import("./index");
    const exportedKeys = Object.keys(aiIndex);
    expect(exportedKeys).toContain("createNavigationAgent");
    expect(exportedKeys).toContain("NAVIGATION_AGENT_ID");
    expect(exportedKeys).not.toContain("createWorkspaceAgent");
    expect(exportedKeys).not.toContain("WORKSPACE_AGENT_ID");
  });
});
