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

  test("searchResources 用调用者 session 检索 resource_item，返回 band + indexStatus", async () => {
    const calls: string[] = [];
    const session = {
      async query(sql: string) {
        calls.push(sql);
        if (sql.includes("FROM ONLY workspace_embedding_profile")) return [null];
        if (sql.includes("FROM resource_item")) {
          return [[{
            id: "resource_item:r1",
            resource_type: "generic_note",
            title: "合同解除案例",
            summary: "解除通知到达即生效。",
            evidence: [],
            tags: [],
            structured_payload: {},
            quality: "user-confirmed",
            created_at: "2026-06-01T08:00:00.000Z",
            updated_at: "2026-06-01T08:00:00.000Z",
          }]];
        }
        return [[]];
      },
    };
    const { searchResourcesTool } = await import("./resource-tools");
    const execute = searchResourcesTool.execute as unknown as (
      input: { workspaceId: string; query: string; answerThreshold?: number },
      ctx: { requestContext: RequestContext },
    ) => Promise<{ status: string; indexStatus: string; results: Array<{ resource: { id: string } }> }>;

    const result = await execute(
      { workspaceId: "workspace:demo", query: "合同解除案例", answerThreshold: 0.3 },
      ctxWithSession(session),
    );

    expect(result.status).toBe("hit");
    expect(result.indexStatus).toBe("index-disabled");
    expect(result.results[0]!.resource.id).toBe("resource_item:r1");
    expect(calls.some((sql) => sql.includes("FROM resource_item"))).toBe(true);
  });

  test("searchResources 没有调用者 session 时直接抛错（不存在 root/legacy 兜底）", async () => {
    const { searchResourcesTool } = await import("./resource-tools");
    const execute = searchResourcesTool.execute as unknown as (
      input: { workspaceId: string; query: string },
      ctx: { requestContext: RequestContext },
    ) => Promise<unknown>;

    await expect(
      execute({ workspaceId: "workspace:demo", query: "x" }, { requestContext: new RequestContext() }),
    ).rejects.toThrow(/surrealSession/);
  });

  test("getResourceDetail 用调用者 session 读取资源详情", async () => {
    const session = {
      async query(sql: string) {
        if (sql.includes("FROM ONLY $resourceId")) {
          return [{
            id: "resource_item:r1",
            resource_type: "generic_note",
            title: "合同解除案例",
            summary: "解除通知到达即生效。",
            evidence: [{ text: "通知到达生效。", capturedAt: "2026-06-01T08:00:00.000Z", order: 0 }],
            tags: [],
            structured_payload: {},
            quality: "user-confirmed",
            created_at: "2026-06-01T08:00:00.000Z",
            updated_at: "2026-06-01T08:00:00.000Z",
          }];
        }
        return [[]];
      },
    };
    const { getResourceDetailTool } = await import("./resource-tools");
    const execute = getResourceDetailTool.execute as unknown as (
      input: { resourceId: string },
      ctx: { requestContext: RequestContext },
    ) => Promise<{ resource: { id: string; title: string } }>;

    const result = await execute({ resourceId: "resource_item:r1" }, ctxWithSession(session));

    expect(result.resource.id).toBe("resource_item:r1");
    expect(result.resource.title).toBe("合同解除案例");
  });
});
