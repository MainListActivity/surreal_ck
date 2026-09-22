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

  test("'查找已有资料' 走 resource-retrieval 类目", async () => {
    const llm = fakeLlm(`[{"category":"resource-retrieval","taskText":"查找已有资料"}]`);
    const plan = await classifyTask({ text: "查找已有资料", llmCaller: llm });
    expect(plan).toEqual([{ category: "resource-retrieval", taskText: "查找已有资料" }]);
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

describe("router classifier 决策模型路径", () => {
  const silentLog = () => {};

  function fakeJev(answers: Record<string, unknown>) {
    let calls = 0;
    const caller: import("../../decision/model").DecisionCaller = async () => {
      calls++;
      return { model: "jev-1.13.0", answers: answers as never, usage: {} };
    };
    return { getCalls: () => calls, caller };
  }

  function jevAnswers(multiProb: number, category: string, confidence: number) {
    return {
      multi_intent: { type: "noul", noul: multiProb },
      category: {
        type: "choice",
        choice: category,
        probabilities: { [category]: confidence },
        confidence,
      },
    };
  }

  test("单意图高置信 → 采用 Jev 答案，不调 llmCaller", async () => {
    const jev = fakeJev(jevAnswers(0.05, "navigation", 0.9));
    let llmCalled = false;
    const llm: RouterLlmCaller = async () => {
      llmCalled = true;
      return `[{"category":"chitchat","taskText":"x"}]`;
    };
    const plan = await classifyTask({
      text: "打开理赔工作簿",
      llmCaller: llm,
      decisionModel: jev.caller,
      onJevDecision: silentLog,
    });
    expect(plan).toEqual([{ category: "navigation", taskText: "打开理赔工作簿" }]);
    expect(llmCalled).toBe(false);
    expect(jev.getCalls()).toBe(1);
  });

  test("多意图（multi noul 达阈值）→ 回退 LLM 出完整 plan", async () => {
    const jev = fakeJev(jevAnswers(0.9, "navigation", 0.95));
    const llm = fakeLlm(`[{"category":"navigation","taskText":"打开工作簿"},{"category":"claim-analysis","taskText":"分析记录"}]`);
    const plan = await classifyTask({
      text: "打开工作簿然后分析这条记录",
      llmCaller: llm,
      decisionModel: jev.caller,
      onJevDecision: silentLog,
    });
    expect(plan).toHaveLength(2);
    expect(plan[0].category).toBe("navigation");
  });

  test("多意图撕裂区间（noul 在 1-T 与 T 之间）→ 回退 LLM", async () => {
    const jev = fakeJev(jevAnswers(0.5, "navigation", 0.95));
    const llm = fakeLlm(`[{"category":"chitchat","taskText":"x"}]`);
    const plan = await classifyTask({
      text: "模糊消息",
      llmCaller: llm,
      decisionModel: jev.caller,
      onJevDecision: silentLog,
    });
    expect(plan).toEqual([{ category: "chitchat", taskText: "x" }]);
  });

  test("单意图但类别置信不足 → 回退 LLM", async () => {
    const jev = fakeJev(jevAnswers(0.1, "navigation", 0.6));
    const llm = fakeLlm(`[{"category":"dashboard","taskText":"做统计"}]`);
    const plan = await classifyTask({
      text: "看看数据",
      llmCaller: llm,
      decisionModel: jev.caller,
      onJevDecision: silentLog,
    });
    expect(plan).toEqual([{ category: "dashboard", taskText: "做统计" }]);
  });

  test("决策模型抛错 → 静默回退 LLM", async () => {
    const jev: import("../../decision/model").DecisionCaller = async () => {
      throw new Error("network down");
    };
    const llm = fakeLlm(`[{"category":"navigation","taskText":"打开工作簿"}]`);
    const plan = await classifyTask({
      text: "打开工作簿",
      llmCaller: llm,
      decisionModel: jev,
      onJevDecision: silentLog,
    });
    expect(plan).toEqual([{ category: "navigation", taskText: "打开工作簿" }]);
  });

  test("Jev 返回非法类别 → 回退 LLM", async () => {
    const jev = fakeJev(jevAnswers(0.1, "not-a-category", 0.95));
    const llm = fakeLlm(`[{"category":"chitchat","taskText":"你好"}]`);
    const plan = await classifyTask({
      text: "你好",
      llmCaller: llm,
      decisionModel: jev.caller,
      onJevDecision: silentLog,
    });
    expect(plan).toEqual([{ category: "chitchat", taskText: "你好" }]);
  });

  test("未提供 decisionModel → 纯 LLM 路径（与接入前一致）", async () => {
    const llm = fakeLlm(`[{"category":"dashboard","taskText":"做图"}]`);
    const plan = await classifyTask({ text: "做个图", llmCaller: llm });
    expect(plan).toEqual([{ category: "dashboard", taskText: "做图" }]);
  });

  test("自定义阈值生效：threshold=0.5 时 noul=0.5 判多意图", async () => {
    const jev = fakeJev(jevAnswers(0.5, "navigation", 0.9));
    const llm = fakeLlm(`[{"category":"navigation","taskText":"x"}]`);
    const plan = await classifyTask({
      text: "打开然后分析",
      llmCaller: llm,
      decisionModel: jev.caller,
      confidenceThreshold: 0.5,
      onJevDecision: silentLog,
    });
    // multi.noul=0.5 >= 0.5 → LLM（若阈值默认 0.75 则会走 Jev）；plan 取 LLM 的 taskText 证明走了回退
    expect(plan).toEqual([{ category: "navigation", taskText: "x" }]);
  });

  test("决策日志带 adopted/model/latencyMs 字段", async () => {
    const events: import("./router-classifier").JevClassifyLog[] = [];
    const jev = fakeJev(jevAnswers(0.05, "chitchat", 0.9));
    const llm = fakeLlm(`[]`);
    await classifyTask({
      text: "你好",
      llmCaller: llm,
      decisionModel: jev.caller,
      onJevDecision: (e) => events.push(e),
    });
    expect(events).toHaveLength(1);
    expect(events[0].adopted).toBe(true);
    expect(events[0].model).toBe("jev-1.13.0");
    expect(typeof events[0].latencyMs).toBe("number");
    expect(events[0].multiProb).toBeCloseTo(0.05);
  });
});
