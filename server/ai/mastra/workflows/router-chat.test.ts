import { describe, expect, test } from "bun:test";
import { Mastra } from "@mastra/core";
import { InMemoryStore } from "@mastra/core/storage";
import { runRouterChat, type RouterChatStreamPusher } from "./router-chat";
import { createRouterWorkflow, ROUTER_WORKFLOW_ID, type SubAgentExecutor, type SubAgentExecutors } from "./router-workflow";
import type { RouterLlmCaller } from "./router-classifier";
import type { AiContextSnapshot } from "@surreal-ck/shared";

const ctx: AiContextSnapshot = {
  route: { screen: "home" },
  workbook: null,
  sheet: null,
  selectedRow: null,
  contextHint: "",
};

// 这些端到端测试用 planOverride / 自定义 executor，不真正跑 tool，因此 session 仅需占位。
const fakeSession = { query: async () => [] } as never;

function streamingExecutor(chunks: string[]): SubAgentExecutor {
  return async ({ taskText: _taskText, shared: _shared }) => {
    return { text: chunks.join(""), confirmed: {}, deltas: chunks };
  };
}

function makeExecutors(overrides: Partial<SubAgentExecutors> = {}): SubAgentExecutors {
  const empty: SubAgentExecutor = async () => ({ text: "", confirmed: {} });
  return {
    navigation: empty,
    dashboard: empty,
    "row-analysis": empty,
    chitchat: empty,
    ...overrides,
  };
}

function makeMastra() {
  return new Mastra({
    storage: new InMemoryStore(),
    workflows: { [ROUTER_WORKFLOW_ID]: createRouterWorkflow() },
  });
}

describe("runRouterChat 端到端", () => {
  test("选中记录的摘要与关联资源 citation 到达最终用户消息", async () => {
    const mastra = makeMastra();
    const userContext: AiContextSnapshot = {
      route: { screen: "editor", workbookId: "workbook:inspection", sheetId: "sheet:devices" },
      workbook: { id: "workbook:inspection", name: "巡检台账" },
      sheet: { id: "sheet:devices", label: "设备", tableName: "ent_devices" },
      selectedRow: {
        id: "ent_devices:pump-7",
        label: "冷却泵 7 号",
        visibleValues: { last_reading: 42, check_status: "待复核", evidence_status: "待补充" },
      },
      contextHint: "设备 / 冷却泵 7 号",
    };
    const executors = makeExecutors({
      "row-analysis": async ({ taskText, shared }) => {
        expect(taskText).toBe("生成当前记录的巡检摘要");
        expect(shared.userContext.selectedRow?.id).toBe("ent_devices:pump-7");
        return {
          text: "上次读数 42；复核状态为待复核；材料待补充。规程依据见 [1]。",
          confirmed: {},
          citations: [{
            index: 1,
            resourceId: "resource_item:manual",
            title: "巡检规程",
            sourceUrl: "https://example.com/manual",
          }],
        };
      },
    });
    const done: Array<{ content: string; citationTitle?: string }> = [];

    const result = await runRouterChat({
      mastra,
      text: "生成当前记录的巡检摘要",
      userContext,
      surrealSession: fakeSession,
      executors,
      llmCaller: async () => "不应调用",
      planOverride: [{ category: "row-analysis", taskText: "生成当前记录的巡检摘要" }],
      streamId: "summary-with-citation",
      pushChunk: (event) => {
        if (event.type !== "done") return;
        done.push({ content: event.message.content, citationTitle: event.message.citations?.[0]?.title });
      },
    });

    expect(result.status).toBe("success");
    expect(done).toEqual([{
      content: "上次读数 42；复核状态为待复核；材料待补充。规程依据见 [1]。",
      citationTitle: "巡检规程",
    }]);
  });

  test("单意图 navigation：聚合 streamId 上的 delta，并最后给一个 done", async () => {
    const mastra = makeMastra();
    const llm: RouterLlmCaller = async () =>
      `[{"category":"navigation","taskText":"打开工作簿"}]`;
    const executors = makeExecutors({
      navigation: streamingExecutor(["已", "找到", "工作簿"]),
    });
    const events: Array<{ type: string; text?: string; finalText?: string }> = [];
    const pushChunk: RouterChatStreamPusher = (e) => {
      if (e.type === "delta") events.push({ type: "delta", text: e.text });
      else if (e.type === "done") events.push({ type: "done", finalText: e.message.content });
    };

    const result = await runRouterChat({
      mastra,
      text: "打开工作簿",
      userContext: ctx,
      surrealSession: fakeSession,
      executors,
      llmCaller: llm,
      streamId: "s1",
      pushChunk,
    });

    expect(events.filter((e) => e.type === "delta").map((e) => e.text)).toEqual(["已", "找到", "工作簿"]);
    expect(events.find((e) => e.type === "done")?.finalText).toBe("已找到工作簿");
    expect(result.runId).toBeDefined();
    expect(result.finalText).toBe("已找到工作簿");
  });

  test("LLM 解析失败时仍能跑完 chitchat fallback 并 done", async () => {
    const mastra = makeMastra();
    const llm: RouterLlmCaller = async () => "garbage";
    const executors = makeExecutors({
      chitchat: streamingExecutor(["你好～"]),
    });
    const events: string[] = [];
    const pushChunk: RouterChatStreamPusher = (e) => {
      if (e.type === "done") events.push(e.message.content);
    };

    await runRouterChat({
      mastra,
      text: "在吗",
      userContext: ctx,
      surrealSession: fakeSession,
      executors,
      llmCaller: llm,
      streamId: "s2",
      pushChunk,
    });

    expect(events).toEqual(["你好～"]);
  });

  test("指定资源搜索计划时跳过 LLM 分类并确定性进入 ResourceAgent", async () => {
    const mastra = makeMastra();
    let llmCalled = false;
    const llm: RouterLlmCaller = async () => {
      llmCalled = true;
      return `[{"category":"chitchat","taskText":"不应执行"}]`;
    };
    const seenTaskTexts: string[] = [];
    const executors = makeExecutors({
      "resource-retrieval": async ({ taskText }) => {
        seenTaskTexts.push(taskText);
        return { text: "资源答案", confirmed: {} };
      },
      chitchat: async () => ({ text: "错误路径", confirmed: {} }),
    });
    const doneMessages: string[] = [];

    await runRouterChat({
      mastra,
      text: "帮我找设备故障相关资料",
      userContext: ctx,
      surrealSession: fakeSession,
      executors,
      llmCaller: llm,
      streamId: "s-resource",
      pushChunk: (e) => {
        if (e.type === "done") doneMessages.push(e.message.content);
      },
      planOverride: [{ category: "resource-retrieval", taskText: "帮我找设备故障相关资料" }],
    });

    expect(llmCalled).toBe(false);
    expect(seenTaskTexts).toEqual(["帮我找设备故障相关资料"]);
    expect(doneMessages).toEqual(["资源答案"]);
  });

  test("两步 plan：deltas 按步骤顺序串起来", async () => {
    const mastra = makeMastra();
    const llm: RouterLlmCaller = async () =>
      `[{"category":"navigation","taskText":"a"},{"category":"chitchat","taskText":"b"}]`;
    const executors = makeExecutors({
      navigation: streamingExecutor(["A1", "A2"]),
      chitchat: streamingExecutor(["B1"]),
    });
    const deltas: string[] = [];
    const pushChunk: RouterChatStreamPusher = (e) => {
      if (e.type === "delta") deltas.push(e.text);
    };

    await runRouterChat({
      mastra,
      text: "复合任务",
      userContext: ctx,
      surrealSession: fakeSession,
      executors,
      llmCaller: llm,
      streamId: "s3",
      pushChunk,
    });

    expect(deltas).toEqual(["A1", "A2", "B1"]);
  });

  test("progress：开始时推 routing，每步前推 agent-step，runId 一致", async () => {
    const mastra = makeMastra();
    const llm: RouterLlmCaller = async () =>
      `[{"category":"navigation","taskText":"a"},{"category":"chitchat","taskText":"b"}]`;
    const executors = makeExecutors({
      navigation: streamingExecutor(["x"]),
      chitchat: streamingExecutor(["y"]),
    });
    const progressEvents: Array<{ kind: string; runId: string; agentName?: string }> = [];

    await runRouterChat({
      mastra,
      text: "复合任务",
      userContext: ctx,
      surrealSession: fakeSession,
      executors,
      llmCaller: llm,
      streamId: "s4",
      pushChunk: () => {},
      pushProgress: (e) => progressEvents.push(e as never),
    });

    const kinds = progressEvents.map((e) => e.kind);
    expect(kinds[0]).toBe("routing");
    const agentSteps = progressEvents.filter((e) => e.kind === "agent-step");
    expect(agentSteps.map((e) => e.agentName)).toEqual(["navigationAgent", "chitchatAgent"]);
    const runIds = new Set(progressEvents.map((e) => e.runId));
    expect(runIds.size).toBe(1);
  });

  test("workflow 失败时抛出可读的底层错误，而不是 [object Object]", async () => {
    const mastra = makeMastra();
    const executors = makeExecutors({
      navigation: async () => {
        throw new Error("navigation blew up");
      },
    });

    await expect(
      runRouterChat({
        mastra,
        text: "打开工作簿",
        userContext: ctx,
        surrealSession: fakeSession,
        executors,
        llmCaller: async () => `[{"category":"navigation","taskText":"a"}]`,
        streamId: "err-readable",
        pushChunk: () => {},
      }),
    ).rejects.toThrow(/navigation blew up/);
  });

  test("Mastra storage 收到 workflow run 快照（验证走的是真正的 workflow 引擎）", async () => {
    const storage = new InMemoryStore();
    const mastra = new Mastra({
      storage,
      workflows: { [ROUTER_WORKFLOW_ID]: createRouterWorkflow() },
    });
    const llm: RouterLlmCaller = async () =>
      `[{"category":"chitchat","taskText":"hi"}]`;
    const executors = makeExecutors({ chitchat: streamingExecutor(["你好"]) });

    await runRouterChat({
      mastra,
      text: "hi",
      userContext: ctx,
      surrealSession: fakeSession,
      executors,
      llmCaller: llm,
      streamId: "s5",
      pushChunk: () => {},
    });

    const workflowsStore = await storage.getStore("workflows");
    expect(workflowsStore).toBeDefined();
    const runs = await workflowsStore!.listWorkflowRuns({ workflowName: ROUTER_WORKFLOW_ID });
    expect(runs.runs.length).toBeGreaterThan(0);
  });
});
