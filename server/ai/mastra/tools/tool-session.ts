import type { Surreal } from "surrealdb";
import { ROUTER_RUNTIME_KEY } from "../workflows/router-workflow";

/**
 * Mastra tool 的 execute 第二参（ToolExecutionContext）中我们关心的部分：requestContext。
 * 用最窄的结构约束，避免把整个 Mastra 类型拖进 tool 文件。
 */
export type ToolRequestContext = {
  requestContext?: { get(key: string): unknown };
};

/**
 * 从 tool execute 的 RequestContext 取调用者 SurrealDB 会话。
 *
 * 会话由 router-chat 在拉起 workflow 前用调用者 OIDC token SIGNIN，挂在 RouterRuntime 上经
 * RequestContext 透传到这里。没有会话即视为致命错误——tool 绝不退回 root/service 连接。
 */
export function getSurrealSession(ctx: ToolRequestContext | undefined): Surreal {
  const runtime = ctx?.requestContext?.get(ROUTER_RUNTIME_KEY) as { surrealSession?: Surreal } | undefined;
  const session = runtime?.surrealSession;
  if (!session) {
    throw new Error(
      `tool: RequestContext 缺少 "${ROUTER_RUNTIME_KEY}.surrealSession"——tool 必须用调用者会话执行，不存在 root/service 兜底`,
    );
  }
  return session;
}
