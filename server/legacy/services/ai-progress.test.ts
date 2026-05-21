import { describe, expect, test } from "bun:test";
import { buildToolCallProgressEvents } from "./ai-progress";

describe("buildToolCallProgressEvents", () => {
  test("把 onStepFinish 的 toolResults 翻译为 tool-call 事件", () => {
    const events = buildToolCallProgressEvents("run_1", {
      toolResults: [
        { toolCallId: "tc1", toolName: "searchWorkbook", result: {} },
        { toolCallId: "tc2", toolName: "navigate", result: {} },
      ],
    });
    expect(events).toEqual([
      { kind: "tool-call", runId: "run_1", toolId: "searchWorkbook" },
      { kind: "tool-call", runId: "run_1", toolId: "navigate" },
    ]);
  });

  test("没有 toolResults 时返回空数组", () => {
    expect(buildToolCallProgressEvents("run_1", { toolResults: [] })).toEqual([]);
    expect(buildToolCallProgressEvents("run_1", {})).toEqual([]);
  });

  test("toolResults 缺 toolName 的项被跳过", () => {
    const events = buildToolCallProgressEvents("run_2", {
      toolResults: [
        { toolCallId: "tc1", toolName: "", result: {} },
        { toolCallId: "tc2", toolName: "searchRecord", result: {} },
      ] as unknown as Array<{ toolCallId: string; toolName: string; result: unknown }>,
    });
    expect(events).toEqual([{ kind: "tool-call", runId: "run_2", toolId: "searchRecord" }]);
  });
});
