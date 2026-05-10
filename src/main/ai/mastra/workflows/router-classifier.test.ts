import { describe, expect, test } from "bun:test";
import { classifyTask, type RouterLlmCaller } from "./router-classifier";

function fakeLlm(jsonReply: string): RouterLlmCaller {
  return async () => jsonReply;
}

describe("router classifier 单意图分类", () => {
  test("'打开工作簿 X' 走 navigation 类目", async () => {
    const llm = fakeLlm(`[{"category":"navigation","taskText":"打开工作簿 X"}]`);
    const plan = await classifyTask({ text: "打开工作簿 X", llmCaller: llm });
    expect(plan).toEqual([{ category: "navigation", taskText: "打开工作簿 X" }]);
  });

  test("'做个统计图' 走 dashboard 类目", async () => {
    const llm = fakeLlm(`[{"category":"dashboard","taskText":"做个统计图"}]`);
    const plan = await classifyTask({ text: "做个统计图", llmCaller: llm });
    expect(plan).toEqual([{ category: "dashboard", taskText: "做个统计图" }]);
  });

  test("'分析这条记录' 走 claim-analysis 类目", async () => {
    const llm = fakeLlm(`[{"category":"claim-analysis","taskText":"分析这条记录"}]`);
    const plan = await classifyTask({ text: "分析这条记录", llmCaller: llm });
    expect(plan).toEqual([{ category: "claim-analysis", taskText: "分析这条记录" }]);
  });

  test("'你好' 走 chitchat 类目", async () => {
    const llm = fakeLlm(`[{"category":"chitchat","taskText":"你好"}]`);
    const plan = await classifyTask({ text: "你好", llmCaller: llm });
    expect(plan).toEqual([{ category: "chitchat", taskText: "你好" }]);
  });

  test("Router 输入文本会传给 llmCaller", async () => {
    let received = "";
    const llm: RouterLlmCaller = async (prompt) => {
      received = prompt;
      return `[{"category":"chitchat","taskText":"x"}]`;
    };
    await classifyTask({ text: "测试输入文本", llmCaller: llm });
    expect(received).toContain("测试输入文本");
  });
});

describe("router classifier 降级行为", () => {
  test("LLM 返回非 JSON 时降级为单步 chitchat", async () => {
    const llm: RouterLlmCaller = async () => "this is not json at all";
    const plan = await classifyTask({ text: "原始用户消息", llmCaller: llm });
    expect(plan).toEqual([{ category: "chitchat", taskText: "原始用户消息" }]);
  });

  test("LLM 返回 JSON 但 schema 校验失败时降级为单步 chitchat", async () => {
    const llm: RouterLlmCaller = async () => `[{"category":"unknown","taskText":"x"}]`;
    const plan = await classifyTask({ text: "原始用户消息", llmCaller: llm });
    expect(plan).toEqual([{ category: "chitchat", taskText: "原始用户消息" }]);
  });

  test("LLM 返回空数组时降级为单步 chitchat", async () => {
    const llm: RouterLlmCaller = async () => "[]";
    const plan = await classifyTask({ text: "原始用户消息", llmCaller: llm });
    expect(plan).toEqual([{ category: "chitchat", taskText: "原始用户消息" }]);
  });

  test("llmCaller 抛错时降级为单步 chitchat", async () => {
    const llm: RouterLlmCaller = async () => {
      throw new Error("boom");
    };
    const plan = await classifyTask({ text: "原始用户消息", llmCaller: llm });
    expect(plan).toEqual([{ category: "chitchat", taskText: "原始用户消息" }]);
  });
});
