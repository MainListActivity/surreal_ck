import { describe, expect, test } from "bun:test";

describe("workspace agent 注册", () => {
  test("workspaceAgent 文件导出一个 Agent 实例", async () => {
    const { workspaceAgent } = await import("./mastra/agents/workspace-agent");
    expect(workspaceAgent).toBeDefined();
    expect(typeof workspaceAgent.generate).toBe("function");
    expect(typeof workspaceAgent.stream).toBe("function");
  });
});
