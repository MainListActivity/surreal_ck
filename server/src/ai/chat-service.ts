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
import type {
  AiChatMessage,
  AiContextSnapshot,
  AiMessageChunkEvent,
  AiProgressEvent,
  AiToolCallRecord,
  ChatStreamEvent,
  ResumeDecision,
  WorkflowSuspendedEvent,
} from "@surreal-ck/shared";
import type { AiChatService } from "../routes/ai-chat";
import type { RouterPlan } from "../../ai/mastra/workflows/router-classifier";
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
  userContext: AiContextSnapshot;
  /** 确定性路由（如 composer 资源检索模式）；缺省走 LLM classifier。 */
  planOverride?: RouterPlan;
  pushChunk: (e: AiMessageChunkEvent) => void;
  pushProgress: (e: AiProgressEvent) => void;
  onSuspend: (e: WorkflowSuspendedEvent) => void;
}) => Promise<{ runId: string; finalText: string; status: "success" | "suspended" }>;

export type ChatResumer = (input: {
  runId: string;
  streamId: string;
  decision: ResumeDecision;
  surrealSession: Surreal;
  userContext: AiContextSnapshot;
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
  return {
    pushChunk(e: AiMessageChunkEvent) {
      // workflow 的 chunk 有三种 type：delta / error / done。各自映射成 ChatStreamEvent kind。
      if (e.type === "delta") {
        bus.publish(runId, { kind: "chunk", runId, text: e.text });
      } else if (e.type === "done") {
        bus.publish(runId, { kind: "done", runId, message: e.message, toolCalls: e.toolCalls });
      } else if (e.type === "error") {
        bus.publish(runId, { kind: "error", runId, code: "chat-error", message: e.message });
      }
    },
    pushProgress(e: AiProgressEvent) {
      bus.publish(runId, { kind: "progress", runId, progress: e });
    },
    onSuspend(e: WorkflowSuspendedEvent) {
      bus.publish(runId, { kind: "suspend", runId, payload: e });
    },
    publishErrorIfNotTerminal(message: string) {
      bus.publish(runId, { kind: "error", runId, code: "chat-failed", message });
    },
  };
}

export function createAiChatService(options: CreateAiChatServiceOptions): AiChatService {
  const { runBus, runner, resumer } = options;

  return {
    async startChat({ runId, message, userContext, surrealSession, composerMode }) {
      const bridge = bridgeToBus(runBus, runId);
      // composer 的「搜索资源」模式 = 确定性单步 plan，不经 LLM 路由（RR-011/RR-014 契约）。
      const planOverride: RouterPlan | undefined = composerMode === "resource-search"
        ? [{ category: "resource-retrieval", taskText: message }]
        : undefined;
      // 后台启动：startChat 必须立即 resolve（D1-04 契约），workflow 异步跑完。
      void (async () => {
        try {
          await runner({
            text: message,
            runId,
            streamId: runId, // streamId 与 runId 同步，前端无需再额外配对
            surrealSession,
            userContext: userContext ?? ({} as AiContextSnapshot),
            planOverride,
            pushChunk: bridge.pushChunk,
            pushProgress: bridge.pushProgress,
            onSuspend: bridge.onSuspend,
          });
          // success / suspended：workflow 自己已 publish done（finalize step）；suspended 不发 done。
        } catch (cause) {
          bridge.publishErrorIfNotTerminal(cause instanceof Error ? cause.message : String(cause));
        }
      })();
    },

    async resumeChat({ runId, decision, surrealSession }) {
      if (!resumer) {
        throw new Error("AiChatService: resumer not configured");
      }
      const bridge = bridgeToBus(runBus, runId);
      void (async () => {
        try {
          await resumer({
            runId,
            streamId: runId,
            decision,
            surrealSession,
            userContext: options.resumeUserContextFallback ?? ({} as AiContextSnapshot),
            pushChunk: bridge.pushChunk,
            pushProgress: bridge.pushProgress,
            onSuspend: bridge.onSuspend,
          });
        } catch (cause) {
          bridge.publishErrorIfNotTerminal(cause instanceof Error ? cause.message : String(cause));
        }
      })();
    },
  };
}

// 防止未用 type 警告（保留 re-export 便于下一切片消费）。
export type { AiChatMessage, AiToolCallRecord, ChatStreamEvent };
