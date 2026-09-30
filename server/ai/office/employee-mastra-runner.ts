import { Mastra } from "@mastra/core";
import { ConsoleLogger } from "@mastra/core/logger";
import { RequestContext } from "@mastra/core/request-context";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import type { Surreal } from "surrealdb";
import { z } from "zod";
import { setExecutionContext } from "../mastra/execution-context";
import { SurrealMastraStore } from "../mastra/storage/surreal-store";
import { createEmployeeEffects } from "./employee-effects";
import type {
  EmployeeRunDriver,
  EmployeeRunResult,
  TriggerEnvelope,
  TriggerHandler,
  TriggerSession,
} from "./employee-trigger-runtime";

/**
 * 员工执行窗口的 durable workflow 驱动（VER04）。
 *
 * - 每个执行窗口构造一个 Mastra 实例：storage resolver 闭包绑死窗口内
 *   员工 RECORD 会话，strict 模式——snapshot 读写失败一律抛出，绝不把
 *   缺失 snapshot 降级成新 run。
 * - workflow "office-employee" 只有一个 execute-job step：从 inputData
 *   拿触发信封，按 reason 解析注册的 handler，注入 session / effects /
 *   suspend / resumeData 后执行。handler 解析是进程内闭包而非持久化
 *   状态——restart/resume 重建窗口时凭同一 reason 找回同一岗位实现。
 * - run 语义映射：无 snapshot → start；snapshot status=running/failed →
 *   Mastra active-run restart（run.restart）；suspended → 仅经
 *   resumeTrigger → run.resume 恢复。
 */

export const EMPLOYEE_WORKFLOW_ID = "office-employee";
const EMPLOYEE_RUNTIME_KEY = "employeeJobRuntime";

const TriggerInputSchema = z.object({
  id: z.string(),
  database: z.string(),
  employeeId: z.string(),
  reason: z.string(),
  payloadRef: z.string().nullable(),
  chainDepth: z.number(),
  idempotencyKey: z.string(),
});

const JobOutputSchema = z.object({ output: z.any() });

type EmployeeJobRuntime = {
  session: TriggerSession;
  resolveHandler: (reason: string) => TriggerHandler | undefined;
};

type EmployeeRunDriverContext = {
  session: TriggerSession;
  database: string;
  employeeId: string;
  resolveHandler: (reason: string) => TriggerHandler | undefined;
};

function buildEmployeeWorkflow() {
  const jobStep = createStep({
    id: "execute-job",
    inputSchema: TriggerInputSchema,
    outputSchema: JobOutputSchema,
    execute: async (ctx) => {
      const { inputData, requestContext, suspend, resumeData } = ctx;
      const runtime = requestContext.get(EMPLOYEE_RUNTIME_KEY) as EmployeeJobRuntime | undefined;
      if (!runtime) throw new Error("employee-job-runtime-missing");
      const handler = runtime.resolveHandler(inputData.reason);
      if (!handler) throw new Error(`no-handler:${inputData.reason}`);
      const output = await handler({
        trigger: inputData as TriggerEnvelope,
        session: runtime.session,
        effects: createEmployeeEffects(runtime.session, inputData.id),
        resumeData,
        suspend: suspend as (payload?: unknown) => Promise<never>,
      });
      return { output };
    },
  });

  return createWorkflow({
    id: EMPLOYEE_WORKFLOW_ID,
    inputSchema: TriggerInputSchema,
    outputSchema: JobOutputSchema,
  })
    .then(jobStep)
    .commit();
}

type MastraRunResult = {
  status: string;
  result?: unknown;
  error?: unknown;
};

function describeRunFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  const messages: string[] = [];
  let cur: unknown = error;
  for (let depth = 0; cur && typeof cur === "object" && depth < 5; depth += 1) {
    const message = (cur as { message?: unknown }).message;
    if (typeof message === "string" && message && !messages.includes(message)) {
      messages.push(message);
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return messages.length ? messages.join(" | caused by: ") : String(error ?? "employee workflow failed");
}

function toRunResult(result: MastraRunResult): EmployeeRunResult {
  if (result.status === "success") {
    const output = (result.result as { output?: unknown } | undefined)?.output;
    return { status: "success", output };
  }
  if (result.status === "suspended") return { status: "suspended" };
  return { status: "failed", error: describeRunFailure(result.error) };
}

export function createMastraEmployeeDriver(
  ctx: EmployeeRunDriverContext,
): EmployeeRunDriver {
  // TriggerSession 在生产环境就是 SIGNIN 完成的 Surreal；storage 只用其 query 能力。
  // strict：snapshot 读失败/缺失一律抛出——员工窗口 fail-closed，绝不降级为新 run。
  const sessionAsDb = ctx.session as unknown as Surreal;
  const store = new SurrealMastraStore(
    () => ({ db: sessionAsDb, subject: ctx.employeeId }),
    undefined,
    { strict: true },
  );
  const storage = store.stores.workflows;
  const mastra = new Mastra({
    storage: store,
    workflows: { [EMPLOYEE_WORKFLOW_ID]: buildEmployeeWorkflow() },
    logger: new ConsoleLogger({ name: "Mastra-employee", level: "warn" }),
  });
  const workflow = mastra.getWorkflow(EMPLOYEE_WORKFLOW_ID);

  function jobContext(): RequestContext {
    const requestContext = new RequestContext();
    setExecutionContext(requestContext, { surrealSession: sessionAsDb });
    requestContext.set(EMPLOYEE_RUNTIME_KEY, {
      session: ctx.session,
      resolveHandler: ctx.resolveHandler,
    } satisfies EmployeeJobRuntime);
    return requestContext;
  }

  return {
    async loadRunState(runId) {
      const snapshot = await storage.loadWorkflowSnapshot({
        workflowName: EMPLOYEE_WORKFLOW_ID,
        runId,
      });
      return snapshot
        ? { status: String(snapshot.status), result: snapshot.result, error: snapshot.error }
        : null;
    },

    async start({ runId, trigger }) {
      const run = await workflow.createRun({ runId });
      const result = (await run.start({
        inputData: trigger,
        requestContext: jobContext(),
      })) as MastraRunResult;
      return toRunResult(result);
    },

    async restart({ runId }) {
      const run = await workflow.createRun({ runId });
      const result = (await run.restart({
        requestContext: jobContext(),
      })) as MastraRunResult;
      return toRunResult(result);
    },

    async resume({ runId, resumeData }) {
      const run = await workflow.createRun({ runId });
      const result = (await run.resume({
        resumeData,
        requestContext: jobContext(),
      })) as MastraRunResult;
      return toRunResult(result);
    },
  };
}
