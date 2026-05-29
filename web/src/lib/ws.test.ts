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

function setup(overrides: { onMessage?: (m: unknown) => void; onClose?: (code: number) => void } = {}) {
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
});
