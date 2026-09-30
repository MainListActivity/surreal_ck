import type { RequestContext } from "@mastra/core/request-context";
import type { Surreal } from "surrealdb";

/**
 * RequestContext 键：本次 Mastra 执行（Router run / employee run 通用）的共享执行上下文。
 * 与具体 workflow 术语无关——任何 run 拉起前都用同一条 seam 注入执行身份。
 */
export const EXECUTION_CONTEXT_KEY = "mastraExecutionContext";

/**
 * 共享执行上下文：一次 Mastra 执行的最小身份载体。
 * - Router run 注入调用者 OIDC token SIGNIN 得到的 admin/participant 会话；
 * - employee run 注入 employee access SIGNIN 得到的 RECORD 会话。
 * tool 与 agent 运行期只能从这里取 SurrealDB 会话。
 */
export type MastraExecutionContext = {
  surrealSession: Surreal;
};

/** 在拉起 workflow run / agent.stream 前注入本次执行身份。 */
export function setExecutionContext(requestContext: RequestContext, ctx: MastraExecutionContext): void {
  requestContext.set(EXECUTION_CONTEXT_KEY, ctx);
}

type RequestContextLike = { get(key: string): unknown };

/** 非抛出读取：给 instructions 这类允许 fail-soft 的消费方用。 */
export function getExecutionContext(requestContext: RequestContextLike | undefined): MastraExecutionContext | undefined {
  return requestContext?.get(EXECUTION_CONTEXT_KEY) as MastraExecutionContext | undefined;
}

/**
 * Mastra tool 的 execute 第二参（ToolExecutionContext）中我们关心的部分：requestContext。
 * 用最窄的结构约束，避免把整个 Mastra 类型拖进 tool 文件。
 */
export type ToolRequestContext = {
  requestContext?: RequestContextLike;
};

/**
 * 从 tool execute 的 RequestContext 取本次执行的 SurrealDB 会话。
 *
 * 会话由调用方在拉起 run 前经 setExecutionContext 注入。没有会话即视为致命错误——
 * tool 绝不退回 root/service 连接，也不存在其它身份兜底。
 */
export function getSurrealSession(ctx: ToolRequestContext | undefined): Surreal {
  const session = getExecutionContext(ctx?.requestContext)?.surrealSession;
  if (!session) {
    throw new Error(
      `tool: RequestContext 缺少 "${EXECUTION_CONTEXT_KEY}.surrealSession"——tool 必须用本次执行的会话执行，不存在 root/service 兜底`,
    );
  }
  return session;
}
