import { beforeEach, describe, expect, mock, test } from "bun:test";

type AuditRow = {
  error_code: string;
  message: string;
  meta: Record<string, unknown>;
};

const auditRows: AuditRow[] = [];
let failWrites = false;

mock.module("../db/index", () => ({
  getLocalDb: () => ({
    query: async (sql: string, params?: Record<string, unknown>) => {
      if (sql.includes("CREATE client_error")) {
        if (failWrites) throw new Error("db unavailable");
        auditRows.push({
          error_code: String(params?.code),
          message: String(params?.msg),
          meta: params?.meta as Record<string, unknown>,
        });
      }
      return [[]];
    },
  }),
}));

mock.module("../auth/session", () => ({
  getSession: () => ({ expiresAt: Date.now() + 3600_000 }),
  getPublicAuthState: () => ({ loggedIn: true, expiresAt: Date.now() + 3600_000 }),
}));

describe("AI tool call audit", () => {
  beforeEach(() => {
    auditRows.length = 0;
    failWrites = false;
  });

  test("记录 tool 名称、意图类型、时间戳和 sessionId，且不保存完整 prompt/API key", async () => {
    const { recordAiToolCall } = await import("./audit");

    await recordAiToolCall({
      sessionId: "run-1",
      toolName: "searchWorkbook",
      args: {
        query: "债权",
        prompt: "这里是完整用户 prompt，不能进入审计",
        apiKey: "sk-secret",
      },
      result: {
        intent: {
          type: "open-workbook",
          workbookId: "workbook:claims",
          label: "债权表",
        },
      },
    });

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      error_code: "AI_TOOL_CALL",
      message: "searchWorkbook:open-workbook",
    });
    expect(auditRows[0].meta).toMatchObject({
      sessionId: "run-1",
      toolName: "searchWorkbook",
      intentType: "open-workbook",
      identifiers: { workbookId: "workbook:claims" },
    });
    expect(typeof auditRows[0].meta.timestamp).toBe("string");
    expect(JSON.stringify(auditRows[0].meta)).not.toContain("sk-secret");
    expect(JSON.stringify(auditRows[0].meta)).not.toContain("完整用户 prompt");
  });

  test("审计写入失败不向上抛错", async () => {
    const { recordAiToolCall } = await import("./audit");
    failWrites = true;

    await expect(recordAiToolCall({
      sessionId: "run-2",
      toolName: "navigate",
      args: { route: "home" },
      result: { intent: { type: "navigate", route: "home" } },
    })).resolves.toBeUndefined();
  });
});
