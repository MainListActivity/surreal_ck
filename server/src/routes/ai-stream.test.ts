import { describe, expect, test } from "bun:test";
import type { ChatStreamEvent } from "@surreal-ck/shared";
import { createRunBus } from "../ai/run-bus";
import { createRunRegistry } from "../ai/run-registry";
import { attachStream, createAiStreamRoutes, type StreamSink } from "./ai-stream";

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


test("installed Bun/Hono WS sends a real 25s heartbeat, then closes exactly after done", async () => {
  const registry = createRunRegistry(); const bus = createRunBus();
  const { streamToken } = registry.register({ runId: "long", ownerSubject: "member", authorize: async () => {} });
  const { routes, websocket } = createAiStreamRoutes({ registry, bus });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: routes.fetch, websocket });
  const frames: ChatStreamEvent[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/chat/stream?runId=long&streamToken=${streamToken}`);
  try {
    await new Promise<void>((resolve, reject) => { socket.onerror = () => reject(new Error("local WS failed")); socket.onmessage = e => {
      const frame = JSON.parse(String(e.data)) as ChatStreamEvent; frames.push(frame);
      if (frame.kind === "ping") { bus.publish("long", { kind: "done", runId: "long", message: {} as never, toolCalls: [] }); }
    }; socket.onclose = e => { expect(e.code).toBe(1000); resolve(); }; });
    expect(frames.map(e => e.kind)).toEqual(["ping", "done"]);
  } finally { socket.close(); server.stop(true); }
}, 35_000);

test("cached result is not sent when current WS authorization rejects", async () => {
  const registry = createRunRegistry(); const bus = createRunBus();
  const { streamToken } = registry.register({ runId: "revoked", ownerSubject: "member", authorize: async () => { throw new Error("revoked"); } });
  bus.publish("revoked", { kind: "done", runId: "revoked", message: {} as never, toolCalls: [] });
  const { routes, websocket } = createAiStreamRoutes({ registry, bus });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: routes.fetch, websocket });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/chat/stream?runId=revoked&streamToken=${streamToken}`);
  let frames = 0;
  try { await new Promise<void>(resolve => { socket.onmessage = () => frames++; socket.onclose = e => { expect(e.code).toBe(1008); resolve(); }; }); expect(frames).toBe(0); }
  finally { socket.close(); server.stop(true); }
});

test("WS closed while authorization is pending does not attach late or send cached result", async () => {
  const registry = createRunRegistry(); const bus = createRunBus();
  let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; }); const held = new Promise<void>(r => { release = r; });
  const { streamToken } = registry.register({ runId: "closing", ownerSubject: "member", authorize: async () => { entered(); await held; } });
  const { routes, websocket } = createAiStreamRoutes({ registry, bus });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: routes.fetch, websocket });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/chat/stream?runId=closing&streamToken=${streamToken}`);
  try {
    await Promise.all([started, new Promise<void>(r => { if (socket.readyState === WebSocket.OPEN) r(); else socket.onopen = () => r(); })]);
    const closed = new Promise<void>(r => { socket.onclose = () => r(); }); socket.close(); await closed; release();
    await Bun.sleep(10);
    bus.publish("closing", { kind: "done", runId: "closing", message: {} as never, toolCalls: [] });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  } finally { release(); socket.close(); server.stop(true); }
});
