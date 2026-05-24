import { describe, expect, test } from "bun:test";
import { RequestContext } from "@mastra/core/request-context";
import { ROUTER_RUNTIME_KEY } from "../workflows/router-workflow";

function ctxWithSession(session: unknown): { requestContext: RequestContext } {
  const requestContext = new RequestContext();
  requestContext.set(ROUTER_RUNTIME_KEY, { surrealSession: session });
  return { requestContext };
}

describe("resource tools — 走调用者 session / 不碰 root", () => {
  test("createResourceDraftIntent 仍是纯 intent 构造，不需要 session 也不碰 legacy", async () => {
    const { createResourceDraftIntentTool } = await import("./resource-tools");
    const execute = createResourceDraftIntentTool.execute as unknown as (input: {
      workspaceId: string;
      title: string;
      summary: string;
      evidence?: [];
    }) => Promise<{ intent: { type: string; draft: { quality: string } } }>;

    const result = await execute({
      workspaceId: "workspace:demo",
      title: "待确认资料",
      summary: "草稿等待确认",
      evidence: [],
    });
    expect(result.intent.type).toBe("resource-draft");
    expect(result.intent.draft.quality).toBe("ai-draft");
  });

  test("searchResources 在资源/向量 schema 定稿前明确抛 TODO（绝不退回 root/legacy 全局连接）", async () => {
    const session = { query: async () => [] };
    const { searchResourcesTool } = await import("./resource-tools");
    const execute = searchResourcesTool.execute as unknown as (
      input: { workspaceId: string; query: string },
      ctx: { requestContext: RequestContext },
    ) => Promise<unknown>;

    await expect(
      execute({ workspaceId: "workspace:demo", query: "x" }, ctxWithSession(session)),
    ).rejects.toThrow(/TODO|schema|未/i);
  });
});
