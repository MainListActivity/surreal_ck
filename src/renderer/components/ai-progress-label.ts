import type { AiProgressEvent } from "../../shared/rpc.types";

/** 把 ai.progressStream 事件渲染成 AI 抽屉顶部的进度文本。 */
export function progressEventToHint(event: AiProgressEvent): string {
  switch (event.kind) {
    case "tool-call":
      return `正在调用 ${event.toolId}…`;
    case "routing":
      return "路由分析中…";
    case "agent-step":
      return `${event.agentName}：${event.taskText}`;
  }
}
