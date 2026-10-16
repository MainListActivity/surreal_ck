import { describe, expect, test } from "bun:test";
import type { AiContextSnapshot } from "@surreal-ck/shared";
import { classifyTask, hasWriteIntentSignal, type RouterLlmCaller } from "./router-classifier";

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

  test("'分析这条记录' 走 row-analysis 类目", async () => {
    const llm = fakeLlm(`[{"category":"row-analysis","taskText":"分析这条记录"}]`);
    const plan = await classifyTask({ text: "分析这条记录", llmCaller: llm });
    expect(plan).toEqual([{ category: "row-analysis", taskText: "分析这条记录" }]);
  });

  test("旧版 claim-analysis 类目输出归一化为 row-analysis（路由兼容）", async () => {
    const llm = fakeLlm(`[{"category":"claim-analysis","taskText":"分析这条记录"}]`);
    const plan = await classifyTask({ text: "分析这条记录", llmCaller: llm });
    expect(plan).toEqual([{ category: "row-analysis", taskText: "分析这条记录" }]);
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
    const llm = fakeLlm(`[{"category":"navigation","taskText":"打开工作簿"},{"category":"row-analysis","taskText":"分析记录"}]`);
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

describe("router classifier 写入意图回归（def-write-intent-misroute）", () => {
  test("写入指令被分类为 row-analysis 而非 chitchat", async () => {
    const text = "把「事项」为 A-001 的那一行的「状态」字段改为「待复核」，只改这一行";
    const llm = fakeLlm(`[{"category":"row-analysis","taskText":"${text}"}]`);
    const plan = await classifyTask({ text, llmCaller: llm });
    expect(plan).toEqual([{ category: "row-analysis", taskText: text }]);
    expect(plan[0].category).not.toBe("chitchat");
  });

  test("创建记录的写入指令同样走 row-analysis", async () => {
    const llm = fakeLlm(`[{"category":"row-analysis","taskText":"新增一条记录"}]`);
    const plan = await classifyTask({ text: "在当前表里新增一条记录", llmCaller: llm });
    expect(plan[0].category).toBe("row-analysis");
  });

  test("复合指令（先定位再写）可拆成 navigation + row-analysis 两步", async () => {
    const llm = fakeLlm(
      `[{"category":"navigation","taskText":"打开理赔工作簿"},{"category":"row-analysis","taskText":"把选中行状态改为待复核"}]`,
    );
    const plan = await classifyTask({
      text: "打开理赔工作簿，然后把选中行状态改为待复核",
      llmCaller: llm,
    });
    expect(plan.map((item) => item.category)).toEqual(["navigation", "row-analysis"]);
  });

  test("传给分类模型的提示词：类目定义覆盖记录写入、判定规则禁止写入落 chitchat", async () => {
    let prompt = "";
    const llm: RouterLlmCaller = async (input) => {
      prompt = input;
      return `[{"category":"chitchat","taskText":"x"}]`;
    };
    await classifyTask({ text: "任意输入", llmCaller: llm });

    // row-analysis 类目定义必须显式覆盖写入/修改/创建语义（生产三次复现根因：定义只写「分析」）
    expect(prompt).toMatch(/row-analysis：[^\n]*写入/);
    expect(prompt).toMatch(/row-analysis：[^\n]*修改/);
    // 判定要点必须明令写入归 row-analysis、禁止落入 chitchat
    expect(prompt).toMatch(/新增、修改、填写、更新、删除记录或字段值的请求一律归入 row-analysis/);
    expect(prompt).toMatch(/绝不能归入 chitchat/);
    // chitchat 兜底只收与工作簿数据无关的消息
    expect(prompt).toMatch(/chitchat：[^\n]*数据无关/);
  });

  test("提示词区分只读提问与写入：字段含义询问不误判为写入", async () => {
    let prompt = "";
    const llm: RouterLlmCaller = async (input) => {
      prompt = input;
      return `[{"category":"row-analysis","taskText":"x"}]`;
    };
    await classifyTask({ text: "「状态」字段是什么意思", llmCaller: llm });
    expect(prompt).toMatch(/只读提问[^\n]*不算写入/);
  });

  test("Jev 决策 criteria 与系统提示同源：row-analysis 覆盖写入，chitchat 排除数据操作", async () => {
    const { buildJevClassifyRequest } = await import("./router-classifier");
    const request = buildJevClassifyRequest("把状态改为待复核");
    const category = request.questions["category"];
    expect(category.type).toBe("choice");
    if (category.type !== "choice") return;

    expect(category.criteria["row-analysis"]).toMatch(/写入|修改|更新|创建/);
    expect(category.criteria["chitchat"]).toMatch(/数据无关|不涉及/);
    // 题目指令本身也要带写入判定（决策模型看不到系统提示词）
    expect(category.instructions).toMatch(/属于 row-analysis/);
  });
});

describe("router classifier 写入意图护栏（qa-return：代词+上下文漏判 chitchat 的确定性兜底）", () => {
  const ctxWithSelectedRow: AiContextSnapshot = {
    route: { screen: "editor" },
    workbook: { id: "workbook:w1", name: "示例工作簿" },
    sheet: { id: "sheet:s1", label: "事项表", tableName: "ent_items" },
    selectedRow: {
      id: "ent_items:r1",
      label: "示例事项-001",
      visibleValues: { field_1: "示例事项-001", field_2: "待处理" },
    },
    contextHint: "事项表 / 示例事项-001",
  };

  test("生产 QA 复现形态：模型把「把这行的状态改为待复核」判 chitchat → 护栏回收为 row-analysis", async () => {
    const text = "把这行的状态改为待复核";
    const llm = fakeLlm(`[{"category":"chitchat","taskText":"${text}"}]`);
    const plan = await classifyTask({ text, llmCaller: llm, userContext: ctxWithSelectedRow });
    expect(plan).toEqual([{ category: "row-analysis", taskText: text }]);
  });

  test("代词表述无上下文时同样不落 chitchat（「这行」自带量词信号）", async () => {
    const text = "把这行的状态改为待复核";
    const llm = fakeLlm(`[{"category":"chitchat","taskText":"${text}"}]`);
    const plan = await classifyTask({ text, llmCaller: llm });
    expect(plan[0].category).toBe("row-analysis");
  });

  test("明确记录名写入被判 chitchat → 护栏回收", async () => {
    const text = "把「示例事项-001」的状态改为待复核";
    const llm = fakeLlm(`[{"category":"chitchat","taskText":"${text}"}]`);
    const plan = await classifyTask({ text, llmCaller: llm, userContext: ctxWithSelectedRow });
    expect(plan[0].category).toBe("row-analysis");
  });

  test("删除/新增等其它写入动词同样被护栏回收", async () => {
    for (const text of ["把这行删了", "在当前表里新增一条记录", "把选中行标记为已完成"]) {
      const llm = fakeLlm(`[{"category":"chitchat","taskText":"${text}"}]`);
      const plan = await classifyTask({ text, llmCaller: llm, userContext: ctxWithSelectedRow });
      expect(plan[0].category).toBe("row-analysis");
    }
  });

  test("Jev 采纳 chitchat 的写入指令也被护栏回收（护栏在 Jev 与 LLM 双路之后）", async () => {
    const jev: import("../../decision/model").DecisionCaller = async () => ({
      model: "jev-1.13.0",
      answers: {
        multi_intent: { type: "noul", noul: 0.02 },
        category: { type: "choice", choice: "chitchat", probabilities: { chitchat: 0.95 }, confidence: 0.95 },
      } as never,
      usage: {},
    });
    const text = "把这行的状态改为待复核";
    const plan = await classifyTask({
      text,
      llmCaller: fakeLlm(`[]`),
      decisionModel: jev,
      userContext: ctxWithSelectedRow,
      onJevDecision: () => {},
    });
    expect(plan).toEqual([{ category: "row-analysis", taskText: text }]);
  });

  test("LLM 输出不可解析时，写入指令兜底升级为 row-analysis 而非死在 chitchat", async () => {
    const llm: RouterLlmCaller = async () => "not json";
    const plan = await classifyTask({
      text: "把这行的状态改为待复核",
      llmCaller: llm,
      userContext: ctxWithSelectedRow,
    });
    expect(plan[0].category).toBe("row-analysis");
  });

  test("纯闲聊不误收：有选中行时「你好，你是谁」仍落 chitchat", async () => {
    const llm = fakeLlm(`[{"category":"chitchat","taskText":"你好，你是谁"}]`);
    const plan = await classifyTask({
      text: "你好，你是谁",
      llmCaller: llm,
      userContext: ctxWithSelectedRow,
    });
    expect(plan).toEqual([{ category: "chitchat", taskText: "你好，你是谁" }]);
  });

  test("只读提问不误收：「这行的状态字段是什么意思」无写入动词，保持 chitchat", async () => {
    const text = "这行的状态字段是什么意思";
    const llm = fakeLlm(`[{"category":"chitchat","taskText":"${text}"}]`);
    const plan = await classifyTask({ text, llmCaller: llm, userContext: ctxWithSelectedRow });
    expect(plan[0].category).toBe("chitchat");
  });

  test("多意图拆分不误伤无写入信号子项：问候项保持 chitchat", async () => {
    const llm = fakeLlm(
      `[{"category":"chitchat","taskText":"你好"},{"category":"row-analysis","taskText":"把状态改为待复核"}]`,
    );
    const plan = await classifyTask({
      text: "你好，把状态改为待复核",
      llmCaller: llm,
      userContext: ctxWithSelectedRow,
    });
    expect(plan.map((item) => item.category)).toEqual(["chitchat", "row-analysis"]);
  });

  test("非 chitchat 项带写入信号同样回收：导航标签下的写入子任务归 row-analysis", async () => {
    const llm = fakeLlm(
      `[{"category":"navigation","taskText":"打开事项表"},{"category":"navigation","taskText":"把这行删掉"}]`,
    );
    const plan = await classifyTask({
      text: "打开事项表，把这行删掉",
      llmCaller: llm,
      userContext: ctxWithSelectedRow,
    });
    expect(plan.map((item) => item.category)).toEqual(["navigation", "row-analysis"]);
  });

  test("hasWriteIntentSignal：省略宾语的祈使写入需页面上下文兜底", async () => {
    expect(hasWriteIntentSignal("改成待复核")).toBe(false);
    expect(hasWriteIntentSignal("改成待复核", ctxWithSelectedRow)).toBe(true);
    expect(hasWriteIntentSignal("把这行的状态改为待复核")).toBe(true);
    expect(hasWriteIntentSignal("你好")).toBe(false);
    expect(hasWriteIntentSignal("这行状态是什么")).toBe(false);
    expect(hasWriteIntentSignal("改天再聊", ctxWithSelectedRow)).toBe(false);
  });
});
