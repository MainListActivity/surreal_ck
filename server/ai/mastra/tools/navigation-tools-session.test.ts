import { describe, expect, test } from "bun:test";
import { RequestContext } from "@mastra/core/request-context";
import { ROUTER_RUNTIME_KEY } from "../workflows/router-workflow";

// ─── 测试替身：记录查询的 Surreal 会话 ─────────────────────────────────────────
//
// navigation-tools 不再走 legacy 全局连接，而是从 RequestContext 里的 RouterRuntime
// 取调用者 surrealSession 跑 SurrealQL。下面的 fake 只实现 tool 用到的 query()。

type QueryCall = { sql: string; vars?: Record<string, unknown> };

function makeFakeSession(opts: {
  /** 每次 query 依次返回的结果（SurrealDB SDK：query 返回 statement 结果数组）。 */
  results: unknown[];
  /** 若设置，query 抛出该错误（模拟 PERMISSIONS 拒绝）。 */
  throwOnQuery?: Error;
}) {
  const calls: QueryCall[] = [];
  let cursor = 0;
  const session = {
    calls,
    async query(sql: string, vars?: Record<string, unknown>) {
      calls.push({ sql, vars });
      if (opts.throwOnQuery) throw opts.throwOnQuery;
      return opts.results[cursor++];
    },
  };
  return session;
}

function ctxWithSession(session: unknown): { requestContext: RequestContext } {
  const requestContext = new RequestContext();
  requestContext.set(ROUTER_RUNTIME_KEY, { surrealSession: session });
  return { requestContext };
}

type SearchWorkbookResult = {
  intent:
    | { type: "ambiguous"; candidates: { label: string; id: string }[] }
    | { type: "open-workbook"; workbookId: string; label: string };
};

describe("searchWorkbook tool — 走调用者 session", () => {
  test("唯一匹配时用 session SELECT workbook 并返回 open-workbook", async () => {
    // SurrealDB SDK query() 返回「每条语句结果」的数组：单条 SELECT → [[row, ...]]
    const session = makeFakeSession({
      results: [[[{ id: "workbook:1", name: "合同管理" }]]],
    });
    const { searchWorkbookTool } = await import("./navigation-tools");
    const execute = searchWorkbookTool.execute as unknown as (
      input: { query: string },
      ctx: { requestContext: RequestContext },
    ) => Promise<SearchWorkbookResult>;

    const result = await execute({ query: "合同" }, ctxWithSession(session));

    // 走的是注入的 session，而不是 legacy 全局连接
    expect(session.calls.length).toBeGreaterThan(0);
    expect(session.calls[session.calls.length - 1].sql).toMatch(/workbook/i);
    expect(result.intent.type).toBe("open-workbook");
    expect((result.intent as { type: "open-workbook"; workbookId: string }).workbookId).toBe("workbook:1");
  });

  test("多个匹配时返回 ambiguous 候选列表", async () => {
    const session = makeFakeSession({
      results: [[[
        { id: "workbook:1", name: "债权台账A" },
        { id: "workbook:2", name: "债权台账B" },
      ]]],
    });
    const { searchWorkbookTool } = await import("./navigation-tools");
    const execute = searchWorkbookTool.execute as unknown as (
      input: { query: string },
      ctx: { requestContext: RequestContext },
    ) => Promise<SearchWorkbookResult>;

    const result = await execute({ query: "债权台账" }, ctxWithSession(session));
    expect(result.intent.type).toBe("ambiguous");
    expect((result.intent as { type: "ambiguous"; candidates: unknown[] }).candidates).toHaveLength(2);
  });

  test("RequestContext 缺少 session 时直接抛错（不退回 root/service 连接）", async () => {
    const { searchWorkbookTool } = await import("./navigation-tools");
    const execute = searchWorkbookTool.execute as unknown as (
      input: { query: string },
      ctx?: { requestContext?: RequestContext },
    ) => Promise<SearchWorkbookResult>;

    // 空 RequestContext：runtime 不存在 → 必须抛错而不是悄悄用 root
    const emptyCtx = { requestContext: new RequestContext() };
    await expect(execute({ query: "x" }, emptyCtx)).rejects.toThrow(/session/i);
  });

  test("session 抛 PERMISSIONS 拒绝时向上抛错（让 workflow 转 chitchat 兜底）", async () => {
    const session = makeFakeSession({
      results: [],
      throwOnQuery: new Error("IAM error: Not enough permissions to perform this action"),
    });
    const { searchWorkbookTool } = await import("./navigation-tools");
    const execute = searchWorkbookTool.execute as unknown as (
      input: { query: string },
      ctx: { requestContext: RequestContext },
    ) => Promise<SearchWorkbookResult>;

    // tool 不得把 PERMISSIONS 拒绝吞成空 ambiguous——必须抛出，由上层兜底
    await expect(execute({ query: "x" }, ctxWithSession(session))).rejects.toThrow(/permission/i);
  });
});
