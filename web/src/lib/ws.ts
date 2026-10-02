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
  /** 建连后长时间没有有效服务端事件时触发，让上层退出 loading。 */
  onIdleTimeout?: () => void;
  idleTimeoutMs?: number;
  /** 单次任务含重连的等待上限，心跳不能无限续期。 */
  lifetimeMs?: number;
  maxReconnects?: number;
  socketFactory?: WsSocketFactory;
  timers?: WsTimers;
};

export type WsHandle = {
  close(): void;
};

const HEARTBEAT_MS = 25_000;
const IDLE_TIMEOUT_MS = 45_000;
const IDLE_TIMEOUT_CLOSE_CODE = 4000;
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
  let idleTimer: number | null = null;
  let reconnectTimer: number | null = null;
  let reconnects = 0;
  let stopped = false;
  const lifetimeTimer = timers.setTimeout(() => {
    if (stopped) return;
    stopped = true;
    stopHeartbeat();
    stopIdleTimer();
    if (reconnectTimer !== null) timers.clearTimeout(reconnectTimer);
    input.onIdleTimeout?.();
    socket?.close(IDLE_TIMEOUT_CLOSE_CODE);
  }, input.lifetimeMs ?? 10 * 60_000);

  function stopHeartbeat(): void {
    if (heartbeat !== null) {
      timers.clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  function stopIdleTimer(): void {
    if (idleTimer !== null) {
      timers.clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function isActiveEvent(message: unknown): boolean {
    if (typeof message !== "object" || message === null) return false;
    const event = message as { kind?: unknown; runId?: unknown };
    return ["ping", "progress", "chunk", "done", "error", "suspend"].includes(String(event.kind))
      && typeof event.runId === "string" && (!input.params?.runId || event.runId === input.params.runId);
  }

  function armIdleTimer(): void {
    if (!input.onIdleTimeout) return;
    stopIdleTimer();
    idleTimer = timers.setTimeout(() => {
      if (stopped) return;
      stopped = true;
      timers.clearTimeout(lifetimeTimer);
      stopHeartbeat();
      input.onIdleTimeout?.();
      socket?.close(IDLE_TIMEOUT_CLOSE_CODE);
    }, input.idleTimeoutMs ?? IDLE_TIMEOUT_MS);
  }

  function deliver(raw: string): void {
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const message = JSON.parse(trimmed) as unknown;
        if (!isActiveEvent(message) || stopped) continue;
        armIdleTimer();
        input.onMessage(message);
      } catch {
        // 非 JSON 行忽略，避免一条坏帧打断整条流。
      }
    }
  }

  function open(): void {
    const sock = factory(target);
    socket = sock;

    sock.onopen = () => {
      if (stopped || socket !== sock) return;
      heartbeat = timers.setInterval(() => sock.send('{"type":"ping"}'), HEARTBEAT_MS);
      armIdleTimer();
    };
    sock.onmessage = (data) => { if (socket === sock) deliver(data); };
    sock.onclose = (code) => {
      if (socket !== sock || stopped) return;
      stopHeartbeat();
      stopIdleTimer();
      if (stopped) return;
      if (reconnects < (input.maxReconnects ?? MAX_RECONNECTS)) {
        const delay = RECONNECT_BASE_MS * 2 ** reconnects;
        reconnects += 1;
        reconnectTimer = timers.setTimeout(open, delay);
      } else {
        // 重连预算耗尽，终止本连接并交给上层决定（重登 / 提示）。
        stopped = true;
        timers.clearTimeout(lifetimeTimer);
        input.onClose?.(code);
      }
    };
    sock.onerror = () => sock.close();
  }

  open();

  return {
    close() {
      stopped = true;
      timers.clearTimeout(lifetimeTimer);
      stopHeartbeat();
      stopIdleTimer();
      if (reconnectTimer !== null) {
        timers.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      socket?.close();
    },
  };
}
