import { Mastra } from "@mastra/core";
import { ConsoleLogger } from "@mastra/core/logger";
import { SurrealMastraStore, type SurrealSessionResolver } from "./storage/surreal-store";
import { createRouterWorkflow, ROUTER_WORKFLOW_ID } from "./workflows/router-workflow";

let _lastMastra: Mastra | null = null;

/**
 * 注入当前请求 / dispatcher 的 SurrealDB 会话解析器。
 * storage 不再持有全局 / root 连接：snapshot、对话历史、观测都按调用者 $auth 归因。
 * 解析器从 Mastra runtime context 取已 SIGNIN 到当前 workspace database 的会话（簇 D1-03 接线）。
 */
export function initMastraForCurrentUser(getSession: SurrealSessionResolver): Mastra {
  const mastra = new Mastra({
    storage: new SurrealMastraStore(getSession),
    workflows: {
      [ROUTER_WORKFLOW_ID]: createRouterWorkflow(),
    },
    logger: new ConsoleLogger({
      name: "Mastra",
      level: "info",
    }),
  });
  _lastMastra = mastra;
  console.log("[ai] Mastra initialized");
  return mastra;
}

export function resetMastra(): void {
  _lastMastra = null;
}

export function getMastra(): Mastra {
  if (!_lastMastra) throw new Error("Mastra not initialized - authenticate before using AI features");
  return _lastMastra;
}
