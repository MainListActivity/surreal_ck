import { describe, expect, test } from "bun:test";

describe("resource tools", () => {
  test("createResourceDraftIntent 只返回 resource-draft 意图，不保存资源", async () => {
    const { createResourceDraftIntentTool } = await import("./resource-tools");
    const execute = createResourceDraftIntentTool.execute as unknown as (input: {
      workspaceId: string;
      resourceType?: string;
      title: string;
      summary: string;
      evidence?: [];
    }) => Promise<{
      intent: {
        type: string;
        draft: {
          workspaceId: string;
          resourceType: string;
          title: string;
          summary: string;
          quality: string;
        };
      };
    }>;

    const result = await execute({
      workspaceId: "workspace:demo",
      title: "待确认资料",
      summary: "先作为草稿等待用户确认。",
      evidence: [],
    });

    expect(result.intent).toMatchObject({
      type: "resource-draft",
      draft: {
        workspaceId: "workspace:demo",
        resourceType: "generic_note",
        title: "待确认资料",
        summary: "先作为草稿等待用户确认。",
        quality: "ai-draft",
      },
    });
  });
});
