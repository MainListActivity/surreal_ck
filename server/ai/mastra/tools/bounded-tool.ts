import {
  AiRunCancelledError,
  AiToolTimeoutError,
  boundedAwait,
  firstAbortOf,
  RUN_DIAGNOSTICS_DEFAULTS,
} from "../../../src/ai/run-diagnostics";
import { callerRunDiagnostics } from "../../../src/ai/caller-session";
import { getExecutionContext, type ToolRequestContext } from "../execution-context";

type ToolCtx = ToolRequestContext & { abortSignal?: AbortSignal };

/**
 * PG-1：tool execute 的有界执行包装。
 * - 上界 = min(配置 toolTimeoutMs（默认 60s）, run 剩余期限)；
 * - 超时抛 AiToolTimeoutError（稳定 code=ai-tool-timeout）并置 run fatal →
 *   触发 run.cancel()，阻止超时结果被当成普通 tool-result 让模型继续走；
 * - 上游 abort（step abortSignal / run 信号）抛 AiRunCancelledError；
 * - 底层 body 迟到 settle 被 mask，不会变成 unhandled rejection。
 *
 * 记账（tool 阶段 op 的 begin/end）在 executor 的 fullStream tool-call/tool-result
 * 处做——那里覆盖全部 tool 而不只是包了本函数的；这里只负责把执行钉在时限内。
 */
export async function runBoundedTool<T>(
  toolId: string,
  ctx: ToolCtx | undefined,
  body: () => Promise<T>,
): Promise<T> {
  const session = getExecutionContext(ctx?.requestContext)?.surrealSession;
  const diag = callerRunDiagnostics(session);
  const timeoutMs = diag ? diag.effectiveMs(diag.config.toolTimeoutMs) : RUN_DIAGNOSTICS_DEFAULTS.toolTimeoutMs;
  try {
    return await boundedAwait(body(), {
      timeoutMs,
      signal: firstAbortOf([ctx?.abortSignal, diag?.runSignal]),
      timeoutError: () => new AiToolTimeoutError(toolId),
      abortedError: () => new AiRunCancelledError(),
    });
  } catch (error) {
    if (error instanceof AiToolTimeoutError) diag?.fail(error);
    throw error;
  }
}
