import { describe, expect, test } from "bun:test";
import { progressEventToHint } from "./ai-progress-label";

describe("progressEventToHint", () => {
  test("tool-call 事件渲染为 '正在调用 …' 文案", () => {
    expect(progressEventToHint({ kind: "tool-call", runId: "r1", toolId: "searchWorkbook" }))
      .toBe("正在调用 searchWorkbook…");
  });

  test("routing 事件渲染为 '路由分析中…'（issue 011/012 预留）", () => {
    expect(progressEventToHint({ kind: "routing", runId: "r1" })).toBe("路由分析中…");
  });

  test("agent-step 事件展示 agent 名 + 任务文本", () => {
    expect(
      progressEventToHint({ kind: "agent-step", runId: "r1", agentName: "navigationAgent", taskText: "查找工作簿" }),
    ).toBe("navigationAgent：查找工作簿");
  });
});
