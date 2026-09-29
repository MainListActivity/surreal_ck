import { describe, expect, test } from "bun:test";
import { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import {
  getExecutionContext,
  getSurrealSession,
  setExecutionContext,
  type ToolRequestContext,
} from "./execution-context";
import { ROUTER_RUNTIME_KEY } from "./workflows/router-workflow";

type QueryCall = { sql: string; vars?: Record<string, unknown> };

/** 记录所有 query 调用的假会话；tag 用来区分"谁"的会话。 */
function makeSession(tag: string) {
  const calls: QueryCall[] = [];
  return {
    calls,
    async query(sql: string, vars?: Record<string, unknown>) {
      calls.push({ sql, vars });
      return [[{ tag }]];
    },
  };
}

/** 只读测试 tool：从共享执行上下文取会话并跑一条 SELECT。 */
const probeReadTool = createTool({
  id: "probeRead",
  description: "测试专用：用本次执行会话跑一条只读 SELECT",
  inputSchema: z.object({}),
  outputSchema: z.object({ tag: z.string() }),
  execute: async (_input, ctx) => {
    const session = getSurrealSession(ctx as ToolRequestContext);
    const result = await session.query("SELECT tag FROM probe LIMIT 1");
    const first = Array.isArray(result) && Array.isArray(result[0]) ? result[0][0] : undefined;
    return { tag: (first as { tag?: string } | undefined)?.tag ?? "" };
  },
});

/** 单步 workflow：step 把 run 的 requestContext 原样传给 tool——模拟任意 run 形态。 */
function makeProbeWorkflow() {
  const step = createStep({
    id: "probe",
    inputSchema: z.object({}),
    outputSchema: z.object({ tag: z.string() }),
    execute: async ({ requestContext }) =>
      probeReadTool.execute({}, { requestContext }) as Promise<{ tag: string }>,
  });
  return createWorkflow({
    id: "probeWorkflow",
    inputSchema: z.object({}),
    outputSchema: z.object({ tag: z.string() }),
  })
    .then(step)
    .commit();
}

async function startProbeRun(session: unknown): Promise<{ status: string; tag?: string }> {
  const requestContext = new RequestContext();
  setExecutionContext(requestContext, { surrealSession: session as never });
  const run = await makeProbeWorkflow().createRun();
  const result = await run.start({ inputData: {}, requestContext });
  return {
    status: result.status,
    tag: result.status === "success" ? (result.result as { tag: string }).tag : undefined,
  };
}

describe("共享执行上下文 seam", () => {
  test("getSurrealSession 返回经 setExecutionContext 注入的会话", () => {
    const requestContext = new RequestContext();
    const session = makeSession("caller");
    setExecutionContext(requestContext, { surrealSession: session as never });

    expect(getSurrealSession({ requestContext })).toBe(session);
    expect(getExecutionContext(requestContext)?.surrealSession).toBe(session);
  });

  test("缺少共享执行上下文时 tool 明确失败", async () => {
    // 空 RequestContext
    await expect(
      probeReadTool.execute({}, { requestContext: new RequestContext() }),
    ).rejects.toThrow(/surrealSession/);
    // 连 requestContext 都没有
    expect(() => getSurrealSession(undefined)).toThrow(/surrealSession/);
  });

  test("仅携带 Router 运行时不构成会话来源——不存在身份兜底", async () => {
    const requestContext = new RequestContext();
    // 旧注入路径：session 挂在 routerRuntime 上。tool 不得再从那里取。
    requestContext.set(ROUTER_RUNTIME_KEY, { surrealSession: makeSession("router-legacy") });

    await expect(
      probeReadTool.execute({}, { requestContext }),
    ).rejects.toThrow(/surrealSession/);
  });

  test("最小 employee run 经同一 seam 使用 employee session 调用只读 tool", async () => {
    const employeeSession = makeSession("employee:claims_risk_reminder");

    const { status, tag } = await startProbeRun(employeeSession);

    expect(status).toBe("success");
    expect(tag).toBe("employee:claims_risk_reminder");
    expect(employeeSession.calls).toHaveLength(1);
  });

  test("两个并发 run 注入不同会话时查询不串台", async () => {
    const sessionA = makeSession("caller-a");
    const sessionB = makeSession("employee-b");

    const [runA, runB] = await Promise.all([startProbeRun(sessionA), startProbeRun(sessionB)]);

    expect(runA.tag).toBe("caller-a");
    expect(runB.tag).toBe("employee-b");
    expect(sessionA.calls).toHaveLength(1);
    expect(sessionB.calls).toHaveLength(1);
    // 各自的会话只看到自己的调用
    expect(sessionA.calls.every((c) => c.sql.includes("probe"))).toBe(true);
    expect(sessionB.calls.every((c) => c.sql.includes("probe"))).toBe(true);
  });
});
