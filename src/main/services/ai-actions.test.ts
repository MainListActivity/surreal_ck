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

import { applyRowPatchIntent, executeAiAction } from "./ai-actions";

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

  test("rowPatch 写动作成功且携带 runId 时清理 workflow run", async () => {
    const rowUpserts: Array<{ sheetId: string; rows: Array<{ id?: string; values: Record<string, unknown> }> }> = [];
    const result = await executeAiAction({
      intent: {
        type: "rowPatch",
        sheetId: "sheet:claims",
        rowId: "ent_claim:abc",
        patch: {
          creditor_name: "张三",
          claim_amount: 1200,
        },
      },
      runId: "run-row-patch",
    }, {
      upsertRows: async (req) => {
        rowUpserts.push(req);
        return { upserted: req.rows.map((row) => ({ id: row.id ?? "ent_claim:new", values: row.values })) };
      },
    });

    expect(result).toEqual({ ok: true, message: "记录已更新。" });
    expect(rowUpserts.length).toBe(1);
    expect(deletes).toEqual([{ workflowName: "routerWorkflow", runId: "run-row-patch" }]);
  });
});

describe("applyRowPatchIntent", () => {
  test("通过 upsertRows 只写入已确认字段", async () => {
    const rowUpserts: Array<{ sheetId: string; rows: Array<{ id?: string; values: Record<string, unknown> }> }> = [];

    await applyRowPatchIntent(
      {
        type: "rowPatch",
        sheetId: "sheet:claims",
        rowId: "ent_claim:abc",
        patch: {
          creditor_name: "张三",
          claim_amount: 1200,
        },
      },
      async (req) => {
        rowUpserts.push(req);
        return { upserted: req.rows.map((row) => ({ id: row.id ?? "ent_claim:new", values: row.values })) };
      },
    );

    expect(rowUpserts).toEqual([
      {
        sheetId: "sheet:claims",
        rows: [
          {
            id: "ent_claim:abc",
            values: {
              creditor_name: "张三",
              claim_amount: 1200,
            },
          },
        ],
      },
    ]);
  });
});
