/**
 * Mastra chat stream 的 WS 客户端封装：拼 url、解析 JSON-line、25s 心跳 ping、
 * 断连自动重连（最多 5 次）。**仅**服务于 `/api/chat/stream`——业务数据走 surrealdb-js 直连。
 */

/** ws.ts 依赖的 WebSocket 最小切面，便于注入 fake 做单测。 */
export type WsSocket = {
  send(data: string): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: ((code: number) => void) | null;
  onerror: (() => void) | null;
};

export type WsSocketFactory = (url: string) => WsSocket;

/** 可注入的定时器切面（单测用假时钟）。 */
export type WsTimers = {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
};

export type ConnectWsInput = {
  url: string;
  params?: Record<string, string>;
  onMessage: (message: unknown) => void;
  /** 重连次数耗尽后回调，附带最后一次的 close code，让上层决定是否重登 / 提示。 */
  onClose?: (code: number) => void;
  socketFactory?: WsSocketFactory;
  timers?: WsTimers;
};

export type WsHandle = {
  close(): void;
};

const HEARTBEAT_MS = 25_000;
const MAX_RECONNECTS = 5;
/** 指数退避基数；第 n 次重连等待 RECONNECT_BASE_MS * 2^(n-1)。 */
const RECONNECT_BASE_MS = 1_000;

function buildUrl(url: string, params?: Record<string, string>): string {
  if (!params || Object.keys(params).length === 0) return url;
  const qs = new URLSearchParams(params).toString();
  return url.includes("?") ? `${url}&${qs}` : `${url}?${qs}`;
}

function browserSocketFactory(url: string): WsSocket {
  const ws = new WebSocket(url);
  const adapter: WsSocket = {
    send: (data) => ws.send(data),
    close: (code) => ws.close(code),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.onopen = () => adapter.onopen?.();
  ws.onmessage = (ev: MessageEvent) => adapter.onmessage?.(String(ev.data));
  ws.onclose = (ev: CloseEvent) => adapter.onclose?.(ev.code);
  ws.onerror = () => adapter.onerror?.();
  return adapter;
}

const browserTimers: WsTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => globalThis.clearTimeout(id),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms) as unknown as number,
  clearInterval: (id) => globalThis.clearInterval(id),
};

export function connectWs(input: ConnectWsInput): WsHandle {
  const factory = input.socketFactory ?? browserSocketFactory;
  const timers = input.timers ?? browserTimers;
  const target = buildUrl(input.url, input.params);

  let socket: WsSocket | null = null;
  let heartbeat: number | null = null;
  let reconnectTimer: number | null = null;
  let reconnects = 0;
  let stopped = false;

  function stopHeartbeat(): void {
    if (heartbeat !== null) {
      timers.clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  function deliver(raw: string): void {
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        input.onMessage(JSON.parse(trimmed));
      } catch {
        // 非 JSON 行忽略，避免一条坏帧打断整条流。
      }
    }
  }

  function open(): void {
    const sock = factory(target);
    socket = sock;

    sock.onopen = () => {
      reconnects = 0; // 成功连上后重置重连预算
      heartbeat = timers.setInterval(() => sock.send('{"type":"ping"}'), HEARTBEAT_MS);
    };
    sock.onmessage = (data) => deliver(data);
    sock.onclose = (code) => {
      stopHeartbeat();
      if (stopped) return;
      if (reconnects < MAX_RECONNECTS) {
        const delay = RECONNECT_BASE_MS * 2 ** reconnects;
        reconnects += 1;
        reconnectTimer = timers.setTimeout(open, delay);
      } else {
        // 重连预算耗尽，终止本连接并交给上层决定（重登 / 提示）。
        stopped = true;
        input.onClose?.(code);
      }
    };
    sock.onerror = () => sock.close();
  }

  open();

  return {
    close() {
      stopped = true;
      stopHeartbeat();
      if (reconnectTimer !== null) {
        timers.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      socket?.close();
    },
  };
}
