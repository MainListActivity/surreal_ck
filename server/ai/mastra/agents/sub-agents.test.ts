import { describe, expect, test } from "bun:test";
import type { AiSettings } from "./model-config";

const fakeSettings: AiSettings = {
  provider: "openai",
  model: "gpt-4o-mini",
  apiFormat: "openai-compatible",
  apiKey: "placeholder-key",
  secretConfigured: true,
};

describe("dashboard agent", () => {
  test("createDashboardAgent 工厂存在并返回 Agent", async () => {
    const mod = await import("./dashboard-agent");
    expect(typeof mod.createDashboardAgent).toBe("function");
    expect(typeof mod.DASHBOARD_AGENT_ID).toBe("string");
    const agent = mod.createDashboardAgent(fakeSettings);
    expect(typeof agent.generate).toBe("function");
  });

  test("dashboard agent 注册 schema 检查与草稿生成工具", async () => {
    const { DASHBOARD_TOOLS } = await import("./dashboard-agent");
    expect(Object.keys(DASHBOARD_TOOLS).sort()).toEqual(["generateDashboardDraft", "inspectSchema"]);
  });

  test("dashboard system prompt 不包含其它领域关键字", async () => {
    const { DASHBOARD_INSTRUCTIONS } = await import("./dashboard-agent");
    expect(DASHBOARD_INSTRUCTIONS).not.toContain("navigate");
    expect(DASHBOARD_INSTRUCTIONS).not.toContain("searchWorkbook");
  });
});

describe("claim-analysis agent 占位", () => {
  test("createClaimAnalysisAgent 工厂存在", async () => {
    const mod = await import("./claim-analysis-agent");
    expect(typeof mod.createClaimAnalysisAgent).toBe("function");
    expect(typeof mod.CLAIM_ANALYSIS_AGENT_ID).toBe("string");
  });

  test("claim-analysis agent 注册债权行分析工具", async () => {
    const { CLAIM_ANALYSIS_TOOLS } = await import("./claim-analysis-agent");
    expect(Object.keys(CLAIM_ANALYSIS_TOOLS).sort()).toEqual(["analyzeClaimRow", "fetchRelatedRecords"]);
  });
});

describe("chitchat agent", () => {
  test("createChitchatAgent 工厂存在并无 tool", async () => {
    const mod = await import("./chitchat-agent");
    expect(typeof mod.createChitchatAgent).toBe("function");
    expect(typeof mod.CHITCHAT_AGENT_ID).toBe("string");
    expect(Object.keys(mod.CHITCHAT_TOOLS)).toEqual([]);
  });
});

describe("resource agent", () => {
  test("createResourceAgent 工厂存在并返回 Agent", async () => {
    const mod = await import("./resource-agent");
    expect(typeof mod.createResourceAgent).toBe("function");
    expect(typeof mod.RESOURCE_AGENT_ID).toBe("string");
    const agent = mod.createResourceAgent(fakeSettings);
    expect(typeof agent.generate).toBe("function");
  });

  test("resource agent 只注册只读/草稿工具，不直接保存资源", async () => {
    const { RESOURCE_TOOLS } = await import("./resource-agent");
    expect(Object.keys(RESOURCE_TOOLS).sort()).toEqual([
      "createResourceDraftIntent",
      "getResourceDetail",
      "searchResources",
    ]);
    expect(Object.keys(RESOURCE_TOOLS)).not.toContain("saveResource");
  });
});
