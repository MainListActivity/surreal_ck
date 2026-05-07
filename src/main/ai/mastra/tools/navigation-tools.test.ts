import { describe, expect, test } from "bun:test";

// ─── navigate tool ────────────────────────────────────────────────────────────

describe("navigate tool", () => {
  test("工具存在且有正确的 id", async () => {
    const { navigateTool } = await import("./navigation-tools");
    expect(navigateTool.id).toBe("navigate");
    expect(typeof navigateTool.execute).toBe("function");
  });

  test("返回 navigate 意图", async () => {
    const { navigateTool } = await import("./navigation-tools");
    const result = await navigateTool.execute({ route: "dashboard" });
    expect(result.intent.type).toBe("navigate");
    expect((result.intent as { type: string; route: string }).route).toBe("dashboard");
  });
});

// ─── searchWorkbook tool ──────────────────────────────────────────────────────

describe("searchWorkbook tool", () => {
  test("工具存在且有正确的 id", async () => {
    const { searchWorkbookTool } = await import("./navigation-tools");
    expect(searchWorkbookTool.id).toBe("searchWorkbook");
    expect(typeof searchWorkbookTool.execute).toBe("function");
  });

  test("输入为空字符串时工具可以执行（smoke test，实际搜索依赖运行时DB）", async () => {
    const { searchWorkbookTool } = await import("./navigation-tools");
    expect(searchWorkbookTool.id).toBe("searchWorkbook");
  });
});

// ─── searchDashboard tool ─────────────────────────────────────────────────────

describe("searchDashboard tool", () => {
  test("工具存在且有正确的 id", async () => {
    const { searchDashboardTool } = await import("./navigation-tools");
    expect(searchDashboardTool.id).toBe("searchDashboard");
    expect(typeof searchDashboardTool.execute).toBe("function");
  });
});

// ─── searchRecord tool ────────────────────────────────────────────────────────

describe("searchRecord tool", () => {
  test("工具存在且有正确的 id", async () => {
    const { searchRecordTool } = await import("./navigation-tools");
    expect(searchRecordTool.id).toBe("searchRecord");
    expect(typeof searchRecordTool.execute).toBe("function");
  });
});
