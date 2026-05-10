import { beforeEach, describe, expect, mock, test } from "bun:test";

const deletes: Array<{ workflowName: string; runId: string }> = [];

mock.module("../ai/index", () => ({
  initMastraForCurrentUser: () => ({
    getStorage: () => ({
      stores: {
        workflows: {
          deleteWorkflowRunById: async (args: { workflowName: string; runId: string }) => {
            deletes.push(args);
          },
        },
      },
    }),
  }),
}));

import { executeAiAction } from "./ai-actions";

describe("executeAiAction", () => {
  beforeEach(() => {
    deletes.length = 0;
  });

  test("open-workbook 意图转换为 editor 路由", async () => {
    const result = await executeAiAction({
      intent: {
        type: "open-workbook",
        workbookId: "workbook:case",
        label: "债权工作簿",
      },
    });

    expect(result).toEqual({
      ok: true,
      navigation: {
        type: "navigate",
        screen: "editor",
        workbookId: "workbook:case",
      },
    });
  });

  test("写动作成功且携带 runId 时调 deleteWorkflowRunById 清理 workflow run", async () => {
    await executeAiAction({
      intent: { type: "open-workbook", workbookId: "wb:1" },
      runId: "run-xyz",
    });
    expect(deletes).toEqual([{ workflowName: "routerWorkflow", runId: "run-xyz" }]);
  });

  test("不携带 runId 时不调 deleteWorkflowRunById", async () => {
    await executeAiAction({
      intent: { type: "open-workbook", workbookId: "wb:1" },
    });
    expect(deletes).toEqual([]);
  });

  test("写动作失败（无可识别意图）时不删 workflow run", async () => {
    const r = await executeAiAction({
      intent: { type: "ambiguous", candidates: [] },
      runId: "run-xyz",
    });
    expect(r.ok).toBe(false);
    expect(deletes).toEqual([]);
  });
});
