/**
 * 生产 AiChatService 装配（D1 簇收口）。
 *
 * 把 D1-04 的 `/api/chat` 注入点接到真 Mastra router workflow：
 *   - startChat → 后台 runRouterChat，pushChunk/pushProgress/onSuspend 翻译成
 *     `ChatStreamEvent` 投递到 D1-05 的 RunBus；workflow 结束 / 抛错 publish 终态。
 *   - resumeChat → 用新 session 走 Mastra resume，事件管线同上。
 *
 * 切分：
 *   - 本文件负责事件**桥接** + 后台启动 + 终态广播；真 Mastra / agents / llmCaller
 *     构造在 `assemble-mastra.ts`（下一切片）。runner 作为依赖注入，便于单测不打真 LLM。
 */

import type { Surreal } from "surrealdb";
import {
  createDefaultAiContextSnapshot,
  type AiContextSnapshot,
  type AiChatMessage,
  type AiMessageChunkEvent,
  type AiProgressEvent,
  type ChatStreamEvent,
  type ResumeDecision,
  type WorkflowSuspendedEvent,
} from "@surreal-ck/shared";
import type { AiChatService, RunTerminalOutcome } from "../routes/ai-chat";
import type { RouterPlan } from "../../ai/mastra/workflows/router-classifier";
import type { OpenContentResearchSession } from "../../ai/mastra/workflows/router-workflow";
import type { RunBus } from "./run-bus";

/**
 * 对 `runRouterChat` / Mastra resume 的最小抽象，便于单测打桩：
 * - 单测注入 fake runner 验证桥接行为
 * - 生产由 assemble-mastra 提供把 Mastra + agents + llmCaller 串起来的实现
 */
export type ChatRunner = (input: {
  text: string;
  runId: string;
  streamId: string;
  surrealSession: Surreal;
  /** 调用者 OIDC subject；stream 授权和 Mastra 上下文识别用，DB 归因走 caller session 的 $auth。 */
  ownerSubject: string;
  userContext: AiContextSnapshot;
  /** 确定性路由（如 composer 资源检索模式）；缺省走 LLM classifier。 */
  planOverride?: RouterPlan;
  /** LCA06：调用者 content_reader 窗口工厂（runtime 注入；缺席 = 不做平台语料研究）。 */
  openContentSession?: OpenContentResearchSession;
  pushChunk: (e: AiMessageChunkEvent) => void;
  pushProgress: (e: AiProgressEvent) => void;
  onSuspend: (e: WorkflowSuspendedEvent) => void;
}) => Promise<{ runId: string; finalText: string; status: "success" | "suspended" }>;

export type ChatResumer = (input: {
  runId: string;
  streamId: string;
  decision: ResumeDecision;
  surrealSession: Surreal;
  /** 调用者 OIDC subject；stream 授权和 Mastra 上下文识别用，DB 归因走 caller session 的 $auth。 */
  ownerSubject: string;
  userContext: AiContextSnapshot;
  openContentSession?: OpenContentResearchSession;
  pushChunk: (e: AiMessageChunkEvent) => void;
  pushProgress: (e: AiProgressEvent) => void;
  onSuspend: (e: WorkflowSuspendedEvent) => void;
}) => Promise<{ runId: string; finalText: string; status: "success" | "suspended" | "cancelled" }>;

export type CreateAiChatServiceOptions = {
  runBus: RunBus;
  runner: ChatRunner;
  /** 可选：resume 用；未注入时 resumeChat 抛 not-implemented。 */
  resumer?: ChatResumer;
  /** resume 时 userContext 的回填策略；默认空快照（workflow 已持久化 state，runtime userContext 仅兜底）。 */
  resumeUserContextFallback?: AiContextSnapshot;
};

/** 把 router workflow runtime 事件桥接到 RunBus。返回三个 pusher + 一个 done/error 终态广播。 */
function bridgeToBus(bus: RunBus, runId: string) {
  let terminalPublished = false;
  const emit = (event: ChatStreamEvent) => {
    if (event.kind === "done" || event.kind === "error") terminalPublished = true;
    bus.publish(runId, event);
  };
  return {
    pushChunk(e: AiMessageChunkEvent) {
      // workflow 的 chunk 有三种 type：delta / error / done。各自映射成 ChatStreamEvent kind。
      if (e.type === "delta") {
        emit({ kind: "chunk", runId, text: e.text });
      } else if (e.type === "done") {
        emit({ kind: "done", runId, message: e.message, toolCalls: e.toolCalls });
      } else if (e.type === "error") {
        emit({ kind: "error", runId, code: "chat-error", message: e.message });
      }
    },
    pushProgress(e: AiProgressEvent) {
      emit({ kind: "progress", runId, progress: e });
    },
    onSuspend(e: WorkflowSuspendedEvent) {
      emit({ kind: "suspend", runId, payload: e });
    },
    publishErrorIfNotTerminal(message: string) {
      emit({ kind: "error", runId, code: "chat-failed", message });
    },
    /**
     * 终态兜底：runner/resumer resolve 出终态却没有投递任何 done/error 时补发。
     * 典型场景：resume 命中持久化 success 快照短路返回，RunBus 终态缓存已过期，
     * 新订阅者只剩心跳——必须保证终态可达。已发过终态则不动（不重复发布）。
     */
    ensureTerminal(result: { finalText: string; status: "success" | "suspended" | "cancelled" }, userContext: AiContextSnapshot) {
      if (terminalPublished) return;
      if (result.status === "success") {
        const message: AiChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: result.finalText || "我没有生成有效回复。",
          createdAt: new Date().toISOString(),
          context: userContext,
        };
        emit({ kind: "done", runId, message, toolCalls: [] });
      } else if (result.status === "cancelled") {
        emit({ kind: "error", runId, code: "chat-run-ended", message: "该运行已结束或不存在，请重新发起对话" });
      }
      // suspended 且未发 suspend 事件时没有可伪造的 payload，不补发。
    },
  };
}

async function closeCallerSession(session: Surreal): Promise<void> {
  const close = (session as unknown as { close?: () => Promise<unknown> | unknown }).close;
  if (typeof close === "function") {
    await close.call(session);
  }
}

export function createAiChatService(options: CreateAiChatServiceOptions): AiChatService {
  const { runBus, runner, resumer } = options;

  return {
    async startChat({ runId, message, userContext, surrealSession, ownerSubject, composerMode, openContentSession, onTerminal }) {
      const bridge = bridgeToBus(runBus, runId);
      // composer 的「搜索资源」模式 = 确定性单步 plan，不经 LLM 路由（RR-011/RR-014 契约）。
      const planOverride: RouterPlan | undefined = composerMode === "resource-search"
        ? [{ category: "resource-retrieval", taskText: message }]
        : undefined;
      // 后台启动：startChat 必须立即 resolve（D1-04 契约），workflow 异步跑完。
      void (async () => {
        let outcome: RunTerminalOutcome = "failed";
        try {
          const result = await runner({
            text: message,
            runId,
            streamId: runId, // streamId 与 runId 同步，前端无需再额外配对
            surrealSession,
            ownerSubject,
            userContext: userContext ?? createDefaultAiContextSnapshot(),
            planOverride,
            openContentSession,
            pushChunk: bridge.pushChunk,
            pushProgress: bridge.pushProgress,
            onSuspend: bridge.onSuspend,
          });
          // success / suspended：workflow 自己已 publish done（finalize step）；suspended 不发 done。
          bridge.ensureTerminal(result, userContext ?? createDefaultAiContextSnapshot());
          outcome = result.status === "success" ? "success" : "suspended";
        } catch (cause) {
          outcome = "failed";
          bridge.publishErrorIfNotTerminal(cause instanceof Error ? cause.message : String(cause));
        } finally {
          // 计量收口（结算/释放预留）不依赖 WS 是否仍连着。
          try {
            await onTerminal?.(outcome);
          } catch {
            // 终态回调失败不回写 run 结果；失联预留由 deadline 清扫兜底。
          }
          await closeCallerSession(surrealSession);
        }
      })();
    },

    async resumeChat({ runId, decision, surrealSession, ownerSubject, openContentSession, onTerminal }) {
      if (!resumer) {
        throw new Error("AiChatService: resumer not configured");
      }
      // LCA07：suspend 已被本次 resume 决策消费，旧回放缓存（含那次 suspend）
      // 必须在此分段丢弃——resume 后的新流订阅若回放到旧 suspend，前端会按
      // suspend 语义自关新流，续跑答案永远不可见。同步执行，保证 resume 端点
      // 返回（客户端随即重连 stream）之前分段生效。
      runBus.segment(runId);
      const bridge = bridgeToBus(runBus, runId);
      const userContext = options.resumeUserContextFallback ?? createDefaultAiContextSnapshot();
      void (async () => {
        let outcome: RunTerminalOutcome = "failed";
        try {
          const result = await resumer({
            runId,
            streamId: runId,
            decision,
            openContentSession,
            surrealSession,
            ownerSubject,
            userContext,
            pushChunk: bridge.pushChunk,
            pushProgress: bridge.pushProgress,
            onSuspend: bridge.onSuspend,
          });
          bridge.ensureTerminal(result, userContext);
          outcome = result.status === "success" ? "success" : result.status === "cancelled" ? "cancelled" : "suspended";
        } catch (cause) {
          outcome = "failed";
          bridge.publishErrorIfNotTerminal(cause instanceof Error ? cause.message : String(cause));
        } finally {
          try {
            await onTerminal?.(outcome);
          } catch {
            // 同上：收口失败不影响 run 结果，deadline 清扫兜底。
          }
          await closeCallerSession(surrealSession);
        }
      })();
    },
  };
}
