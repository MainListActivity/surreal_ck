import { describe, expect, test } from "bun:test";
import { connectWs, type WsSocket, type WsSocketFactory } from "./ws";

/** 受 ws.ts 依赖的 WebSocket 最小切面的可控 fake。 */
class FakeSocket implements WsSocket {
  static instances: FakeSocket[] = [];
  url: string;
  sent: string[] = [];
  closed = false;
  closeCode?: number;
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: ((code: number) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closed = true;
    this.closeCode = code;
  }
  // 测试触发器
  open(): void {
    this.onopen?.();
  }
  message(data: string): void {
    this.onmessage?.(data);
  }
  serverClose(code = 1006): void {
    this.onclose?.(code);
  }
}

function fakeClock() {
  let now = 0;
  const timers: { id: number; at: number; fn: () => void; interval?: number }[] = [];
  let nextId = 1;
  const setTimer = (fn: () => void, ms: number, interval?: number): number => {
    const id = nextId++;
    timers.push({ id, at: now + ms, fn, interval });
    return id;
  };
  return {
    setTimeout: (fn: () => void, ms: number) => setTimer(fn, ms),
    clearTimeout: (id: number) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    setInterval: (fn: () => void, ms: number) => setTimer(fn, ms, ms),
    clearInterval: (id: number) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    advance(ms: number) {
      const target = now + ms;
      // 反复触发到点的 timer（interval 重新排程）
      // 防御无限循环：interval 至少 1ms。
      for (;;) {
        const due = timers
          .filter((t) => t.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        if (due.interval) {
          due.at = now + due.interval;
        } else {
          const i = timers.indexOf(due);
          if (i >= 0) timers.splice(i, 1);
        }
        due.fn();
      }
      now = target;
    },
  };
}

function setup(overrides: {
  onMessage?: (m: unknown) => void;
  onClose?: (code: number) => void;
  onIdleTimeout?: () => void;
} = {}) {
  FakeSocket.instances = [];
  const clock = fakeClock();
  const messages: unknown[] = [];
  const closes: number[] = [];
  const factory: WsSocketFactory = (url) => new FakeSocket(url);

  const handle = connectWs({
    url: "ws://api.test/api/chat/stream",
    params: { runId: "r1", streamToken: "tok" },
    onMessage: overrides.onMessage ?? ((m) => messages.push(m)),
    onClose: overrides.onClose ?? ((code) => closes.push(code)),
    onIdleTimeout: overrides.onIdleTimeout,
    socketFactory: factory,
    timers: clock,
  });

  return { handle, clock, messages, closes };
}

describe("WS 客户端", () => {
  test("用 path + params 拼出 WS url 并把 JSON line 解析后交给 onMessage", () => {
    const { messages } = setup();
    const sock = FakeSocket.instances[0];

    expect(sock.url).toBe("ws://api.test/api/chat/stream?runId=r1&streamToken=tok");

    sock.open();
    sock.message('{"kind":"chunk","runId":"r1","text":"he"}\n');
    sock.message('{"kind":"chunk","runId":"r1","text":"llo"}\n');

    expect(messages).toEqual([
      { kind: "chunk", runId: "r1", text: "he" },
      { kind: "chunk", runId: "r1", text: "llo" },
    ]);
  });

  test("连上后每 25s 发一次心跳 ping", () => {
    const { clock } = setup();
    const sock = FakeSocket.instances[0];
    sock.open();

    expect(sock.sent).toHaveLength(0);
    clock.advance(25_000);
    expect(sock.sent).toHaveLength(1);
    clock.advance(25_000);
    expect(sock.sent).toHaveLength(2);
  });

  test("每次非主动断连都在退避后重连一次", () => {
    const { clock } = setup();

    FakeSocket.instances[0].serverClose(1006);
    expect(FakeSocket.instances).toHaveLength(1); // 退避前不重连
    clock.advance(60_000);
    expect(FakeSocket.instances).toHaveLength(2); // 退避后新开一条
  });

  test("最多重连 5 次后放弃，并用最后的 close code 回调 onClose", () => {
    const closes: number[] = [];
    const { clock } = setup({ onClose: (code) => closes.push(code) });

    // 反复断连：初始 1 条 + 最多 5 次重连 = 6 个 socket，第 6 次断连不再重连。
    for (let i = 0; i < 10; i++) {
      FakeSocket.instances[FakeSocket.instances.length - 1].serverClose(1006);
      clock.advance(60_000);
    }

    expect(FakeSocket.instances).toHaveLength(1 + 5);
    expect(closes).toEqual([1006]);
  });

  test("主动 close 不触发重连、不回调 onClose", () => {
    const closes: number[] = [];
    const { handle, clock } = setup({ onClose: (code) => closes.push(code) });

    handle.close();
    expect(FakeSocket.instances[0].closed).toBe(true);
    clock.advance(60_000);

    expect(FakeSocket.instances).toHaveLength(1);
    expect(closes).toEqual([]);
  });

  test("117s 研究的有效服务端心跳维持连接，完整终态交付", () => {
    let timeouts = 0;
    const { clock, messages } = setup({ onIdleTimeout: () => { timeouts += 1; } });
    const socket = FakeSocket.instances[0]!;
    socket.open();
    for (let i = 0; i < 4; i++) {
      clock.advance(25_000);
      socket.message('{"kind":"ping","runId":"r1"}');
    }
    clock.advance(17_000);
    socket.message('{"kind":"done","runId":"r1","message":{"content":"完整结果"},"toolCalls":[]}');
    expect(timeouts).toBe(0);
    expect(socket.closed).toBe(false);
    expect(messages.at(-1)).toMatchObject({ kind: "done" });
  });

  test("最后一个有效 ping 后静默45s → 真正超时并关闭 socket", () => {
    let idleTimeouts = 0;
    const { clock } = setup({ onIdleTimeout: () => { idleTimeouts += 1; } });
    const sock = FakeSocket.instances[0];
    sock.open();

    sock.message('{"kind":"ping","runId":"r1"}\n');
    clock.advance(44_999);
    expect(idleTimeouts).toBe(0);
    expect(sock.closed).toBe(false);

    clock.advance(1);
    expect(idleTimeouts).toBe(1);
    expect(sock.closed).toBe(true);
    expect(sock.closeCode).toBe(4000);
  });
});


test("68s 追问进度维持连接；错误或旧 run 心跳不能延长静默窗口", () => {
  let timeouts = 0;
  const h = setup({ onIdleTimeout: () => timeouts++ });
  const socket = FakeSocket.instances[0]!; socket.open();
  h.clock.advance(30_000); socket.message('{"kind":"progress","runId":"r1"}');
  h.clock.advance(38_000); socket.message('{"kind":"done","runId":"r1"}');
  expect(timeouts).toBe(0);
  h.handle.close();
  const stale = setup({ onIdleTimeout: () => timeouts++ });
  const old = FakeSocket.instances[0]!; old.open();
  stale.clock.advance(30_000);
  old.message('{"kind":"ping","runId":"other"}'); old.message('bad json');
  stale.clock.advance(15_000); expect(timeouts).toBe(1);
});

test("持续心跳仍受10分钟总上限约束；关闭后晚到 open/message 不复活", () => {
  let timeouts = 0;
  const h = setup({ onIdleTimeout: () => timeouts++ });
  const socket = FakeSocket.instances[0]!; socket.open();
  for (let i = 0; i < 23; i++) { h.clock.advance(25_000); socket.message('{"kind":"ping","runId":"r1"}'); }
  h.clock.advance(25_000); expect(timeouts).toBe(1); expect(socket.closed).toBe(true);
  socket.open(); socket.message('{"kind":"done","runId":"r1"}');
  h.clock.advance(25_000); expect(h.messages.some(e => typeof e === "object" && e !== null && "kind" in e && e.kind === "done")).toBe(false);
});

test("反复成功建连也不刷新五次重连预算；旧 socket 关闭不影响新连接", () => {
  const h = setup();
  const old = FakeSocket.instances[0]!; old.open(); old.serverClose(); h.clock.advance(1000);
  const fresh = FakeSocket.instances[1]!; fresh.open(); old.serverClose(); h.clock.advance(1000);
  expect(FakeSocket.instances).toHaveLength(2);
  for (let i = 1; i < 6; i++) { FakeSocket.instances.at(-1)!.open(); FakeSocket.instances.at(-1)!.serverClose(); h.clock.advance(32_000); }
  expect(FakeSocket.instances).toHaveLength(6); expect(h.closes).toEqual([1006]);
});
