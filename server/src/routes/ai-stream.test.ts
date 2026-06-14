import { describe, expect, test } from "bun:test";
import type { ChatStreamEvent } from "@surreal-ck/shared";
import { createRunBus } from "../ai/run-bus";
import { createRunRegistry } from "../ai/run-registry";
import { attachStream, type StreamSink } from "./ai-stream";

function fakeSink() {
  const sent: string[] = [];
  let closed: { code?: number; reason?: string } | undefined;
  const sink: StreamSink = {
    send: (data) => sent.push(data),
    close: (code, reason) => {
      closed = { code, reason };
    },
  };
  return {
    sink,
    sent,
    events: () => sent.map((s) => JSON.parse(s) as ChatStreamEvent),
    get closed() {
      return closed;
    },
  };
}

describe("attachStream", () => {
  test("streamToken 校验通过 → 回放缓存事件并接续后续；done 终态后关闭", () => {
    const registry = createRunRegistry();
    const bus = createRunBus();
    const { streamToken } = registry.register({ runId: "run-1", ownerSubject: "alice" });
    bus.publish("run-1", { kind: "progress", runId: "run-1", progress: { kind: "routing", runId: "run-1" } });

    const f = fakeSink();
    const result = attachStream({ runId: "run-1", streamToken, registry, bus, sink: f.sink });
    expect(result.ok).toBe(true);

    // 已缓存的 progress 被回放
    expect(f.events().map((e) => e.kind)).toEqual(["progress"]);

    // 后续 chunk 接续推送
    bus.publish("run-1", { kind: "chunk", runId: "run-1", text: "嗨" });
    expect(f.events().map((e) => e.kind)).toEqual(["progress", "chunk"]);

    // done → 仍推给客户端，然后关闭 WS
    bus.publish("run-1", { kind: "done", runId: "run-1", message: {} as never, toolCalls: [] });
    expect(f.events().map((e) => e.kind)).toEqual(["progress", "chunk", "done"]);
    expect(f.closed).toBeDefined();
  });

  test("streamToken 不匹配（别人的 run / 伪造 token）→ 403，且不订阅任何事件", () => {
    const registry = createRunRegistry();
    const bus = createRunBus();
    registry.register({ runId: "run-1", ownerSubject: "alice" });

    const f = fakeSink();
    const result = attachStream({ runId: "run-1", streamToken: "forged", registry, bus, sink: f.sink });

    expect(result).toMatchObject({ ok: false, status: 403, code: "stream-forbidden" });

    // 即便之后 run 真的产出事件，也不会推给这个未授权 sink
    bus.publish("run-1", { kind: "chunk", runId: "run-1", text: "leak?" });
    expect(f.sent).toEqual([]);
  });

  test("done 之后才连上的迟到订阅者（TTL 内）也能回放到 done 并随即被关闭", () => {
    const registry = createRunRegistry();
    const bus = createRunBus();
    const { streamToken } = registry.register({ runId: "run-1", ownerSubject: "alice" });
    bus.publish("run-1", { kind: "chunk", runId: "run-1", text: "hi" });
    bus.publish("run-1", { kind: "done", runId: "run-1", message: {} as never, toolCalls: [] });

    const f = fakeSink();
    const result = attachStream({ runId: "run-1", streamToken, registry, bus, sink: f.sink });

    expect(result.ok).toBe(true);
    expect(f.events().map((e) => e.kind)).toEqual(["chunk", "done"]);
    expect(f.closed).toBeDefined();
  });

  test("error 终态会回放给迟到订阅者并关闭 stream", () => {
    const registry = createRunRegistry();
    const bus = createRunBus();
    const { streamToken } = registry.register({ runId: "run-1", ownerSubject: "alice" });
    bus.publish("run-1", { kind: "error", runId: "run-1", code: "chat-failed", message: "storage failed" });

    const f = fakeSink();
    const result = attachStream({ runId: "run-1", streamToken, registry, bus, sink: f.sink });

    expect(result.ok).toBe(true);
    expect(f.events()).toEqual([{ kind: "error", runId: "run-1", code: "chat-failed", message: "storage failed" }]);
    expect(f.closed).toBeDefined();
  });
});
