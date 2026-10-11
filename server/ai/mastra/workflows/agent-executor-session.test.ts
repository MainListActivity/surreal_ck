import { describe, expect, test } from "bun:test";
import type { Agent } from "@mastra/core/agent";
import { AgentStreamInterruptedError, makeAgentExecutor } from "./agent-executor";
import { ROUTER_RUNTIME_KEY } from "./router-workflow";
import { EXECUTION_CONTEXT_KEY } from "../execution-context";
import type { AiContextSnapshot } from "@surreal-ck/shared";

function emptyUserContext(): AiContextSnapshot {
  return {
    route: { screen: "home" },
    workbook: null,
    sheet: null,
    selectedRow: null,
    contextHint: "",
  } as unknown as AiContextSnapshot;
}

// 记录 stream() 收到的 options 的 fake agent
function makeRecordingAgent(): { agent: Agent; lastOptions: () => unknown } {
  let captured: unknown;
  const agent = {
    async stream(_messages: unknown, options: unknown) {
      captured = options;
      return {
        // 与 MastraModelOutput.fullStream 同形状：payload 包裹的 chunk。
        fullStream: (async function* () {
          yield { type: "text-start", payload: { id: "t1" } };
          yield { type: "text-delta", payload: { id: "t1", text: "ok" } };
          yield { type: "text-end", payload: { id: "t1" } };
        })(),
        text: Promise.resolve("ok"),
      };
    },
  } as unknown as Agent;
  return { agent, lastOptions: () => captured };
}

describe("makeAgentExecutor — 把调用者 session 透传给 tool", () => {
  test("agent.stream 收到的 requestContext 经共享执行上下文携带 surrealSession", async () => {
    const { agent, lastOptions } = makeRecordingAgent();
    const executor = makeAgentExecutor(agent);
    const session = { __isSession: true };

    await executor({
      taskText: "打开工作簿",
      shared: { userContext: emptyUserContext(), confirmed: {} },
      surrealSession: session as never,
    });

    const options = lastOptions() as { requestContext?: { get(key: string): unknown } };
    expect(options.requestContext).toBeDefined();
    const execCtx = options.requestContext!.get(EXECUTION_CONTEXT_KEY) as { surrealSession?: unknown };
    expect(execCtx?.surrealSession).toBe(session);
    // Router 私有数据仍走 ROUTER_RUNTIME_KEY，但不再携带会话
    const runtime = options.requestContext!.get(ROUTER_RUNTIME_KEY) as { userContext?: unknown; surrealSession?: unknown };
    expect(runtime?.userContext).toBeDefined();
    expect(runtime?.surrealSession).toBeUndefined();
  });

  test("surrealSession 缺席时不写共享执行上下文（tool 将 fail-closed）", async () => {
    const { agent, lastOptions } = makeRecordingAgent();
    const executor = makeAgentExecutor(agent);

    await executor({
      taskText: "闲聊",
      shared: { userContext: emptyUserContext(), confirmed: {} },
    });

    const options = lastOptions() as { requestContext?: { get(key: string): unknown } };
    expect(options.requestContext!.get(EXECUTION_CONTEXT_KEY)).toBeUndefined();
  });
});

describe("makeAgentExecutor — LLM stream 失败不得伪装成空回复", () => {
  test("fullStream 无产出且 stream.error 存在时抛 AgentStreamInterruptedError（cause 保留）", async () => {
    const agent = {
      async stream() {
        return {
          fullStream: (async function* () {})(),
          text: Promise.resolve(""),
          error: new Error("model route not found"),
          finishReason: Promise.resolve("error"),
        };
      },
    } as unknown as Agent;
    const executor = makeAgentExecutor(agent);

    const error = await executor({
      taskText: "你好",
      shared: { userContext: emptyUserContext(), confirmed: {} },
    }).then(() => undefined, (err: unknown) => err);

    expect(error).toBeInstanceOf(AgentStreamInterruptedError);
    expect((error as AgentStreamInterruptedError).code).toBe("ai-stream-interrupted");
    expect((error as AgentStreamInterruptedError).message).toContain("生成流中断");
    expect((error as AgentStreamInterruptedError).cause).toBeInstanceOf(Error);
    expect(((error as AgentStreamInterruptedError).cause as Error).message).toBe("model route not found");
  });
});
