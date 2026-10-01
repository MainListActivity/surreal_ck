import { describe, expect, test } from "bun:test";
import type { Agent } from "@mastra/core/agent";
import { buildExecutors, buildRouterLlmCaller } from "./assemble-mastra";

describe("buildRouterLlmCaller", () => {
  test("把 agent.generate(prompt) 的 text 作为 llmCaller 返回值", async () => {
    let captured: unknown;
    const fakeAgent = {
      async generate(input: unknown) {
        captured = input;
        return { text: `[{"category":"chitchat","taskText":"hi"}]` };
      },
    };
    const llm = buildRouterLlmCaller(fakeAgent as never);
    const out = await llm("意图路由 prompt");
    expect(captured).toBe("意图路由 prompt");
    expect(out).toBe(`[{"category":"chitchat","taskText":"hi"}]`);
  });
});

describe("buildExecutors", () => {
  // Agent 用最小占位（buildExecutors 不调用它，只把它包成 executor 闭包）
  const fakeAgent = {} as unknown as Agent;

  test("不带 resource deps → 4 个必选 executor（无 resource-retrieval）", () => {
    const executors = buildExecutors({
      navigationAgent: fakeAgent,
      dashboardAgent: fakeAgent,
      rowAnalysisAgent: fakeAgent,
      chitchatAgent: fakeAgent,
    });
    expect(typeof executors.navigation).toBe("function");
    expect(typeof executors.dashboard).toBe("function");
    expect(typeof executors["row-analysis"]).toBe("function");
    expect(typeof executors.chitchat).toBe("function");
    expect(executors["resource-retrieval"]).toBeUndefined();
  });

  test("传入 resource deps → 第 5 个 executor 上线（resource-retrieval）", () => {
    const executors = buildExecutors(
      {
        navigationAgent: fakeAgent,
        dashboardAgent: fakeAgent,
        rowAnalysisAgent: fakeAgent,
        chitchatAgent: fakeAgent,
      },
      {
        resource: {
          searchResources: async (req) => ({
            status: "miss",
            indexStatus: "index-disabled",
            queryText: req.query,
            results: [],
          }),
        },
      },
    );
    expect(typeof executors["resource-retrieval"]).toBe("function");
  });
});

describe("createMastraRunner", () => {
  test("runner 调用注入的 runRouterChat，且把 surrealSession / executors / llmCaller / push 回调全部喂下去", async () => {
    const calls: Array<{ text: string; runId?: string }> = [];
    let captured: { surrealSession: unknown; executorsKind: string[]; hasLlm: boolean; hasPush: boolean } | undefined;

    const { createMastraRunner } = await import("./assemble-mastra");
    const runner = createMastraRunner({
      // 装配级 fake：跳过真实 agent / Mastra 构造
      buildAgents: () => ({
        navigationAgent: {} as never,
        dashboardAgent: {} as never,
        rowAnalysisAgent: {} as never,
        chitchatAgent: {} as never,
      }),
      buildLlmCaller: () => async () => `[{"category":"chitchat","taskText":"x"}]`,
      buildMastra: () => ({} as never),
      runRouterChat: async (input) => {
        calls.push({ text: input.text, runId: input.runId });
        captured = {
          surrealSession: input.surrealSession,
          executorsKind: Object.keys(input.executors),
          hasLlm: typeof input.llmCaller === "function",
          hasPush: typeof input.pushChunk === "function",
        };
        return { runId: input.runId ?? "r", finalText: "ok", status: "success" };
      },
    });

    const session = { tag: "session" } as never;
    await runner.runner({
      text: "嗨",
      runId: "run-1",
      streamId: "run-1",
      surrealSession: session,
      userContext: { route: { screen: "home" }, workbook: null, sheet: null, selectedRow: null, contextHint: "" },
      pushChunk: () => {},
      pushProgress: () => {},
      onSuspend: () => {},
    });

    expect(calls[0]).toEqual({ text: "嗨", runId: "run-1" });
    expect(captured?.surrealSession).toBe(session);
    // RR-014：未显式注入 resource deps 时默认基于调用者 session 装配 resource-retrieval
    expect(captured?.executorsKind).toEqual([
      "navigation",
      "dashboard",
      "row-analysis",
      "chitchat",
      "resource-retrieval",
    ]);
    expect(captured?.hasLlm).toBe(true);
    expect(captured?.hasPush).toBe(true);
  });

  test("runner 把 answerResourceSelection 传给 runRouterChat：用调用者 session 回查详情产出 [1] citation", async () => {
    let capturedAnswer:
      | ((input: { resourceIds: string[]; taskText: string; userContext: never }) => Promise<{ text: string; citations?: Array<{ resourceId: string }> }>)
      | undefined;

    const { createMastraRunner } = await import("./assemble-mastra");
    const runner = createMastraRunner({
      buildAgents: () => ({
        navigationAgent: {} as never,
        dashboardAgent: {} as never,
        rowAnalysisAgent: {} as never,
        chitchatAgent: {} as never,
      }),
      buildLlmCaller: () => async () => "[]",
      buildMastra: () => ({} as never),
      runRouterChat: async (input) => {
        capturedAnswer = input.answerResourceSelection as never;
        return { runId: input.runId ?? "r", finalText: "", status: "success" };
      },
    });

    // 假调用者 session：getResourceDetail 的 SELECT FROM ONLY 返回资源行
    const session = {
      async query(sql: string) {
        if (sql.includes("FROM ONLY $resourceId")) {
          return [{
            id: "resource_item:r1",
            resource_type: "generic_note",
            title: "设备故障案例",
            summary: "解除通知到达即生效。",
            evidence: [{ text: "通知到达生效。", capturedAt: "2026-06-01T08:00:00.000Z", order: 0 }],
            tags: [],
            structured_payload: {},
            quality: "user-confirmed",
            created_at: "2026-06-01T08:00:00.000Z",
            updated_at: "2026-06-01T08:00:00.000Z",
          }];
        }
        return [[]];
      },
    } as never;

    await runner.runner({
      text: "查找设备故障案例",
      runId: "run-1",
      streamId: "run-1",
      surrealSession: session,
      userContext: { route: { screen: "home" }, workbook: null, sheet: null, selectedRow: null, contextHint: "" },
      pushChunk: () => {},
      pushProgress: () => {},
      onSuspend: () => {},
    });

    expect(typeof capturedAnswer).toBe("function");
    const answer = await capturedAnswer!({
      resourceIds: ["resource_item:r1"],
      taskText: "查找设备故障案例",
      userContext: {} as never,
    });
    expect(answer.text).toContain("[1]");
    expect(answer.citations?.[0]?.resourceId).toBe("resource_item:r1");
  });

  test("resumer 调用注入的 resumeWorkflow，喂下去 decision + 新 session + executors / llmCaller / push", async () => {
    let captured: { runId: string; decision: unknown; session: unknown; hasLlm: boolean; hasAnswerResourceSelection?: boolean } | undefined;

    const { createMastraRunner } = await import("./assemble-mastra");
    const { runner: _r, resumer } = createMastraRunner({
      buildAgents: () => ({
        navigationAgent: {} as never,
        dashboardAgent: {} as never,
        rowAnalysisAgent: {} as never,
        chitchatAgent: {} as never,
      }),
      buildLlmCaller: () => async () => "[]",
      buildMastra: () => ({} as never),
      runRouterChat: async (i) => ({ runId: i.runId ?? "r", finalText: "", status: "success" }),
      resumeWorkflow: async (input) => {
        captured = {
          runId: input.runId,
          decision: input.decision,
          session: input.surrealSession,
          hasLlm: typeof input.llmCaller === "function",
          hasAnswerResourceSelection: typeof input.answerResourceSelection === "function",
        };
        return { runId: input.runId, finalText: "已确认", status: "success" };
      },
    });

    const newSession = { tag: "new-session" } as never;
    const result = await resumer({
      runId: "run-1",
      streamId: "run-1",
      decision: { kind: "write-confirmed" },
      surrealSession: newSession,
      ownerSubject: "user-123",
      userContext: { route: { screen: "home" }, workbook: null, sheet: null, selectedRow: null, contextHint: "" },
      pushChunk: () => {},
      pushProgress: () => {},
      onSuspend: () => {},
    });

    expect(captured?.runId).toBe("run-1");
    expect(captured?.decision).toEqual({ kind: "write-confirmed" });
    expect(captured?.session).toBe(newSession);
    expect(captured?.hasLlm).toBe(true);
    // resume 路径（resource-candidates-chosen / manual-research-completed）需要 citation 生成器
    expect(captured?.hasAnswerResourceSelection).toBe(true);
    expect(result.status).toBe("success");
  });

  test("同一 runId 的决定重试命中已成功快照时直接返回，不重复 resume 已完成步骤", async () => {
    let resumeCalls = 0;
    const pushed: Array<{ type: string; message?: { content: string; citations?: unknown[] } }> = [];
    const { createMastraRunner } = await import("./assemble-mastra");
    const { resumer } = createMastraRunner({
      buildAgents: () => ({
        navigationAgent: {} as never,
        dashboardAgent: {} as never,
        rowAnalysisAgent: {} as never,
        chitchatAgent: {} as never,
      }),
      buildLlmCaller: () => async () => "[]",
      buildMastra: () => ({
        getWorkflow: () => ({
          createRun: async () => ({
            resume: async () => {
              resumeCalls += 1;
              return { status: "success", result: { finalText: "不应执行" } };
            },
          }),
        }),
        getStorage: () => ({
          stores: {
            workflows: {
              getWorkflowRunById: async () => ({
                runId: "run-complete",
                workflowName: "router",
                snapshot: {
                  status: "success",
                  result: {
                    finalText: "历史答复",
                    steps: [{ category: "chitchat", taskText: "t", text: "历史答复", citations: [{ title: "民法典" }] }],
                  },
                },
              }),
            },
          },
        }),
      } as never),
    });

    const result = await resumer({
      runId: "run-complete",
      streamId: "run-complete",
      decision: { kind: "write-confirmed" },
      surrealSession: {} as never,
      ownerSubject: "user-123",
      userContext: { route: { screen: "home" }, workbook: null, sheet: null, selectedRow: null, contextHint: "" },
      pushChunk: (e) => pushed.push(e as never),
      pushProgress: () => {},
      onSuspend: () => {},
    });

    // 短路不重复执行步骤，但必须按持久化 result 重建 done 终态——
    // RunBus 终态缓存过期后，迟到订阅者只能靠这次投递拿到结果。
    expect(result).toEqual({ runId: "run-complete", finalText: "历史答复", status: "success" });
    expect(resumeCalls).toBe(0);
    const done = pushed.find((e) => e.type === "done");
    expect(done?.message?.content).toBe("历史答复");
    expect(done?.message?.citations).toEqual([{ title: "民法典" }]);
  });
});


test("LCA07 已完成研究重试不回放历史平台文本；新的授权窗口必须重新研究", async () => {
  const { createMastraRunner } = await import("./assemble-mastra");
  const events: unknown[] = [];
  let resumed = 0;
  const { resumer } = createMastraRunner({
    buildAgents: () => ({ navigationAgent: {} as never, dashboardAgent: {} as never, claimAnalysisAgent: {} as never, chitchatAgent: {} as never }),
    buildLlmCaller: () => async () => "[]",
    buildMastra: () => ({ getWorkflow: () => ({ createRun: async () => ({ resume: async () => { resumed++; } }) }),
      getStorage: () => ({ stores: { workflows: { getWorkflowRunById: async () => ({ snapshot: { status: "success", result: {
        finalText: "REVOKED-OLD-CANARY", steps: [{ category: "resource-retrieval", taskText: "合同", text: "REVOKED-OLD-CANARY" }] } } }) } } }) } as never),
  });
  const result = await resumer({ runId: "complete", streamId: "complete", decision: { kind: "research-retry" }, surrealSession: {} as never,
    ownerSubject: "human", userContext: { route: { screen: "home" }, workbook: null, sheet: null, selectedRow: null, contextHint: "" },
    pushChunk: e => events.push(e), pushProgress: () => {}, onSuspend: e => events.push(e) });
  expect(result.status).toBe("suspended"); expect(resumed).toBe(0);
  expect(events[0]).toMatchObject({ kind: "authorization_changed", restart: true, query: "合同" });
  expect(JSON.stringify(events)).not.toContain("REVOKED-OLD-CANARY");
});
