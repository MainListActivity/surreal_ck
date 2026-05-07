import { describe, expect, test, mock } from "bun:test";

mock.module("../../../services/context", () => ({
  assertAuthenticated: () => {},
  assertWritable: () => {},
  getOfflineMode: () => false,
  getServiceContext: () => ({ isAuthenticated: true, isOffline: false, readOnly: false }),
  setOfflineMode: () => {},
  getCurrentUserRecordId: async () => ({ tb: "app_user", id: "test" }),
  assertCanReadWorkspace: async () => {},
  assertCanWriteWorkspace: async () => {},
}));

mock.module("../../../db/index", () => ({
  getLocalDb: () => ({
    query: async () => [[{ id: "workspace:test" }]],
  }),
  getRemoteDb: () => null,
}));

mock.module("../../../services/workbooks", () => ({
  listWorkbooks: async () => ({ workbooks: [] }),
}));

describe("searchWorkbook tool — 无结果降级", () => {
  test("工作簿不存在时返回空 ambiguous 候选", async () => {
    const { searchWorkbookTool } = await import("./navigation-tools");
    const result = await searchWorkbookTool.execute({ query: "不存在的工作簿" });
    expect(result.intent.type).toBe("ambiguous");
    expect((result.intent as { type: string; candidates: unknown[] }).candidates).toHaveLength(0);
  });

  test("找到多个工作簿时返回 ambiguous 候选列表", async () => {
    mock.module("../../../services/workbooks", () => ({
      listWorkbooks: async () => ({
        workbooks: [
          { id: "workbook:1", name: "债权台账A", workspaceId: "workspace:test" },
          { id: "workbook:2", name: "债权台账B", workspaceId: "workspace:test" },
        ],
      }),
    }));
    const { searchWorkbookTool } = await import("./navigation-tools");
    const result = await searchWorkbookTool.execute({ query: "债权台账" });
    expect(result.intent.type).toBe("ambiguous");
    expect((result.intent as { type: string; candidates: { label: string; id: string }[] }).candidates).toHaveLength(2);
  });

  test("找到唯一工作簿时返回 open-workbook 意图", async () => {
    mock.module("../../../services/workbooks", () => ({
      listWorkbooks: async () => ({
        workbooks: [{ id: "workbook:1", name: "合同管理", workspaceId: "workspace:test" }],
      }),
    }));
    const { searchWorkbookTool } = await import("./navigation-tools");
    const result = await searchWorkbookTool.execute({ query: "合同管理" });
    expect(result.intent.type).toBe("open-workbook");
    expect((result.intent as { type: string; workbookId: string }).workbookId).toBe("workbook:1");
  });
});
