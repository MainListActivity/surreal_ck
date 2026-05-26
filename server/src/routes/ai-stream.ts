import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import type { ChatStreamEvent } from "@surreal-ck/shared";
import type { AppBindings } from "../hono-types";
import type { RunBus } from "../ai/run-bus";
import type { RunRegistry } from "../ai/run-registry";

/** WS 写出 / 关闭抽象，便于把握手 + 转发逻辑与 Bun WSContext 解耦做单测。 */
export type StreamSink = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type AttachStreamInput = {
  runId: string;
  streamToken: string;
  registry: RunRegistry;
  bus: RunBus;
  sink: StreamSink;
};

export type AttachStreamResult =
  | { ok: true; detach: () => void }
  | { ok: false; status: number; code: string };

/**
 * 把一个已建立的 WS（sink）接到 RunBus：先校验 streamToken→runId→owner，
 * 通过后订阅 runId（RunBus 会先回放缓存的全部事件，再接后续），把每条事件
 * 序列化成一行 JSON 发给客户端；遇到 done / error 终态则关闭 WS。
 *
 * 校验失败返回 { ok:false, status, code }，由调用方决定怎么拒（HTTP 403 或 WS close）。
 * workflow 本身在后台进程继续跑——关 WS 不影响它，客户端可重连再订阅。
 */
export function attachStream(input: AttachStreamInput): AttachStreamResult {
  const { runId, streamToken, registry, bus, sink } = input;

  const record = registry.resolveStreamToken({ runId, streamToken });
  if (!record) {
    // token 不匹配 / 过期 / 非本人持有 → 统一 403，不泄漏 run 是否存在。
    return { ok: false, status: 403, code: "stream-forbidden" };
  }

  let closed = false;
  // 终态可能在 backlog 回放阶段（subscribe 同步触发 listener）就到达，
  // 此时 unsubscribe 尚未返回——用可变 ref 延后取，避免 TDZ。
  let unsubscribe: (() => void) | undefined;

  function detach() {
    unsubscribe?.();
  }

  unsubscribe = bus.subscribe(runId, (event: ChatStreamEvent) => {
    if (closed) return;
    sink.send(JSON.stringify(event));
    if (event.kind === "done" || event.kind === "error") {
      closed = true;
      detach();
      sink.close(1000, "stream-complete");
    }
  });

  return { ok: true, detach };
}

export type AiStreamRoutesDeps = {
  registry: RunRegistry;
  bus: RunBus;
};

const HEARTBEAT_MS = 25_000;

/**
 * `/api/chat/stream?runId=&streamToken=` —— 只推送 router workflow 运行过程事件，
 * 不转发 SurrealDB LIVE（数据行变更由浏览器直连 SurrealDB LIVE SELECT）。
 *
 * 不允许把 OIDC token 放进 query string（代理 / 日志泄漏）；鉴权用 POST /api/chat
 * 返回的短期 streamToken（run-scoped，TTL 5min）。
 */
export function createAiStreamRoutes(deps: AiStreamRoutesDeps): {
  routes: Hono<AppBindings>;
  websocket: ReturnType<typeof createBunWebSocket<ServerWebSocket>>["websocket"];
} {
  const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();
  const routes = new Hono<AppBindings>();

  routes.get(
    "/api/chat/stream",
    upgradeWebSocket((c) => {
      const runId = c.req.query("runId") ?? "";
      const streamToken = c.req.query("streamToken") ?? "";
      let attached: AttachStreamResult | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;

      return {
        onOpen(_evt, ws) {
          const sink: StreamSink = {
            send: (data) => ws.send(data),
            close: (code, reason) => ws.close(code, reason),
          };
          attached = attachStream({ runId, streamToken, registry: deps.registry, bus: deps.bus, sink });
          if (!attached.ok) {
            // 鉴权失败：WS 已升级，只能用 close code 拒（1008 = policy violation）。
            ws.close(1008, attached.code);
            return;
          }
          heartbeat = setInterval(() => {
            ws.send(JSON.stringify({ kind: "ping", runId } satisfies ChatStreamEvent));
          }, HEARTBEAT_MS);
        },
        onClose() {
          if (heartbeat) clearInterval(heartbeat);
          if (attached?.ok) attached.detach();
        },
      };
    }),
  );

  return { routes, websocket };
}
