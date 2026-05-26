import { describe, expect, test } from "bun:test";
import { CHAT_STREAM_TERMINAL_RETENTION_MS, type ChatStreamEvent } from "@surreal-ck/shared";
import { createRunBus } from "./run-bus";

function collect(): { events: ChatStreamEvent[]; listener: (e: ChatStreamEvent) => void } {
  const events: ChatStreamEvent[] = [];
  return { events, listener: (e) => events.push(e) };
}

describe("RunBus", () => {
  test("订阅者后连上也能回放此前已发布的全部事件（缓存全部+重放）", () => {
    const bus = createRunBus();
    bus.publish("run-1", { kind: "progress", runId: "run-1", progress: { kind: "routing", runId: "run-1" } });
    bus.publish("run-1", { kind: "chunk", runId: "run-1", text: "你" });
    bus.publish("run-1", { kind: "chunk", runId: "run-1", text: "好" });

    const sink = collect();
    bus.subscribe("run-1", sink.listener);

    expect(sink.events.map((e) => e.kind)).toEqual(["progress", "chunk", "chunk"]);
    expect(sink.events[1]).toMatchObject({ kind: "chunk", text: "你" });
  });

  test("订阅后发布的事件会广播给订阅者；取消订阅后不再收到", () => {
    const bus = createRunBus();
    const sink = collect();
    const unsubscribe = bus.subscribe("run-1", sink.listener);

    bus.publish("run-1", { kind: "chunk", runId: "run-1", text: "a" });
    unsubscribe();
    bus.publish("run-1", { kind: "chunk", runId: "run-1", text: "b" });

    expect(sink.events.map((e) => (e.kind === "chunk" ? e.text : e.kind))).toEqual(["a"]);
  });

  test("不同 runId 的事件互不串台", () => {
    const bus = createRunBus();
    bus.publish("run-1", { kind: "chunk", runId: "run-1", text: "x" });

    const sink = collect();
    bus.subscribe("run-2", sink.listener);

    expect(sink.events).toEqual([]);
  });

  test("done 后保留 TTL 内仍可回放，越过 TTL 后清理（迟到订阅拿不到）", () => {
    let now = 1_000_000;
    const bus = createRunBus(() => now);
    bus.publish("run-1", { kind: "chunk", runId: "run-1", text: "hi" });
    bus.publish("run-1", { kind: "done", runId: "run-1", message: doneMessage(), toolCalls: [] });

    // TTL 内迟到订阅仍回放全部
    now += CHAT_STREAM_TERMINAL_RETENTION_MS - 1;
    const inWindow = collect();
    bus.subscribe("run-1", inWindow.listener);
    expect(inWindow.events.map((e) => e.kind)).toEqual(["chunk", "done"]);

    // 越过 TTL 后清理，再订阅拿不到历史
    now += 2;
    const afterWindow = collect();
    bus.subscribe("run-1", afterWindow.listener);
    expect(afterWindow.events).toEqual([]);
  });
});

// RunBus 不解释 message 内容，只按 kind 路由；此处构造一个最小占位 done 消息。
function doneMessage(): ChatStreamEvent extends infer E
  ? E extends { kind: "done"; message: infer M }
    ? M
    : never
  : never {
  return {
    id: "m1",
    role: "assistant",
    content: "done",
    createdAt: "2026-05-26T00:00:00.000Z",
  } as never;
}
