import { describe, expect, test } from "bun:test";

describe("router workflow Mastra 包装", () => {
  test("createRouterWorkflow 返回带 createRun 的 Mastra workflow", async () => {
    const { createRouterWorkflow } = await import("./router-workflow");
    const wf = createRouterWorkflow();
    expect(typeof wf.createRun).toBe("function");
    // workflow id 是稳定常量，issue 010 storage 用它做 key
    expect((wf as unknown as { id: string }).id).toBe("routerWorkflow");
  });

  test("ROUTER_WORKFLOW_ID 常量被导出，便于其它模块引用", async () => {
    const { ROUTER_WORKFLOW_ID } = await import("./router-workflow");
    expect(ROUTER_WORKFLOW_ID).toBe("routerWorkflow");
  });
});
