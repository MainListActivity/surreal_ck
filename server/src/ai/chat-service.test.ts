import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import type { AiContextSnapshot, ChatStreamEvent, ResumeDecision } from "@surreal-ck/shared";
import { createRunBus } from "./run-bus";
import { createAiChatService, type ChatRunner } from "./chat-service";

const ctx: AiContextSnapshot = {
  route: { screen: "home" },
  workbook: null,
  sheet: null,
  selectedRow: null,
  contextHint: "",
};
const fakeSession = {} as unknown as Surreal;

function collect(bus: ReturnType<typeof createRunBus>, runId: string) {
  const events: ChatStreamEvent[] = [];
  bus.subscribe(runId, (e) => events.push(e));
  return events;
}

describe("AiChatService.startChat", () => {
  test("把 runRouterChat 的 pushChunk(delta) 翻译成 bus.publish({kind:'chunk'})，并透传 surrealSession + runId + text", async () => {
    const bus = createRunBus();
    // 捕获 service 喂给 runRouterChat 的参数
    let capturedInput: Parameters<ChatRunner>[0] | undefined;
    const runner: ChatRunner = async (input) => {
      capturedInput = input;
      input.pushChunk({ streamId: input.streamId, type: "delta", text: "你好" });
      return { runId: input.runId!, finalText: "你好", status: "success" };
    };

    const service = createAiChatService({ runBus: bus, runner });
    await service.startChat({ runId: "run-1", message: "嗨", userContext: ctx, surrealSession: fakeSession });
    // startChat 立即 resolve，但 runner 是异步——等一拍让 microtask 跑完
    await new Promise((r) => setTimeout(r, 0));

    expect(capturedInput?.text).toBe("嗨");
    expect(capturedInput?.runId).toBe("run-1");
    expect(capturedInput?.surrealSession).toBe(fakeSession);

    const events = collect(bus, "run-1");
    expect(events.some((e) => e.kind === "chunk" && e.text === "你好")).toBe(true);
  });

  test("workflow pushChunk(done) 翻译成 bus done 事件（携带 message + toolCalls）", async () => {
    const bus = createRunBus();
    const runner: ChatRunner = async (input) => {
      input.pushChunk({
        streamId: input.streamId,
        type: "done",
        message: { id: "m1", role: "assistant", content: "已完成", createdAt: "t", context: ctx },
        toolCalls: [{ toolName: "navigation.open", args: { id: "a" }, result: {} }],
      });
      return { runId: input.runId, finalText: "已完成", status: "success" };
    };
    const service = createAiChatService({ runBus: bus, runner });

    const events: ChatStreamEvent[] = [];
    bus.subscribe("run-1", (e) => events.push(e));
    await service.startChat({ runId: "run-1", message: "x", userContext: ctx, surrealSession: fakeSession });
    await new Promise((r) => setTimeout(r, 0));

    const done = events.find((e) => e.kind === "done");
    expect(done).toMatchObject({ kind: "done", runId: "run-1" });
    expect((done as { message: { content: string } }).message.content).toBe("已完成");
    expect((done as { toolCalls: { toolName: string }[] }).toolCalls[0]?.toolName).toBe("navigation.open");
  });

  test("workflow pushProgress / onSuspend 翻译成 bus progress / suspend 事件", async () => {
    const bus = createRunBus();
    const runner: ChatRunner = async (input) => {
      input.pushProgress({ kind: "routing", runId: input.runId });
      input.onSuspend({
        kind: "ambiguous-candidates",
        runId: input.runId,
        candidates: [{ id: "a", label: "A" }],
      });
      return { runId: input.runId, finalText: "", status: "suspended" };
    };
    const service = createAiChatService({ runBus: bus, runner });

    const events: ChatStreamEvent[] = [];
    bus.subscribe("run-1", (e) => events.push(e));
    await service.startChat({ runId: "run-1", message: "x", userContext: ctx, surrealSession: fakeSession });
    await new Promise((r) => setTimeout(r, 0));

    const progress = events.find((e) => e.kind === "progress");
    expect((progress as { progress: { kind: string } } | undefined)?.progress.kind).toBe("routing");
    const suspend = events.find((e) => e.kind === "suspend");
    expect((suspend as { payload: { kind: string } } | undefined)?.payload.kind).toBe("ambiguous-candidates");
  });

  test("resumeChat 用新 session 走 resumer，事件桥接同样有效", async () => {
    const bus = createRunBus();
    let capturedResume: { surrealSession: Surreal; decision: ResumeDecision; runId: string } | undefined;
    const resumer = (async (input) => {
      capturedResume = { surrealSession: input.surrealSession, decision: input.decision, runId: input.runId };
      input.pushChunk({ streamId: input.streamId, type: "delta", text: "继续" });
      return { runId: input.runId, finalText: "继续", status: "success" as const };
    }) satisfies import("./chat-service").ChatResumer;

    const service = createAiChatService({
      runBus: bus,
      runner: async (i) => ({ runId: i.runId, finalText: "", status: "success" }),
      resumer,
    });

    const events: ChatStreamEvent[] = [];
    bus.subscribe("run-1", (e) => events.push(e));
    await service.resumeChat({
      runId: "run-1",
      decision: { kind: "write-confirmed" },
      surrealSession: fakeSession,
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(capturedResume?.runId).toBe("run-1");
    expect(capturedResume?.decision).toEqual({ kind: "write-confirmed" });
    expect(capturedResume?.surrealSession).toBe(fakeSession);
    expect(events.some((e) => e.kind === "chunk" && e.text === "继续")).toBe(true);
  });

  test("resumeChat 未注入 resumer → 抛错（路由层会翻成 501/500）", async () => {
    const bus = createRunBus();
    const service = createAiChatService({
      runBus: bus,
      runner: async (i) => ({ runId: i.runId, finalText: "", status: "success" }),
    });
    await expect(
      service.resumeChat({
        runId: "run-1",
        decision: { kind: "write-confirmed" },
        surrealSession: fakeSession,
      }),
    ).rejects.toThrow(/resumer not configured/);
  });

  test("runner 抛错 → publish error 事件，不向上抛（startChat 已经 resolve）", async () => {
    const bus = createRunBus();
    const runner: ChatRunner = async () => {
      throw new Error("LLM provider 500");
    };
    const service = createAiChatService({ runBus: bus, runner });

    const events: ChatStreamEvent[] = [];
    bus.subscribe("run-1", (e) => events.push(e));
    await service.startChat({ runId: "run-1", message: "x", userContext: ctx, surrealSession: fakeSession });
    await new Promise((r) => setTimeout(r, 0));

    const err = events.find((e) => e.kind === "error");
    expect(err).toMatchObject({ kind: "error", runId: "run-1", code: "chat-failed" });
    expect((err as { message: string }).message).toBe("LLM provider 500");
  });
});
