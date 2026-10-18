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
  WindowGates,
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
  /** 认领时绑定的 durable run id；旧 snapshot 的 inputData 可能缺该字段。 */
  runId: z.string().nullable().optional(),
});

const JobOutputSchema = z.object({ output: z.any() });

type EmployeeJobRuntime = {
  session: TriggerSession;
  resolveHandler: (reason: string) => TriggerHandler | undefined;
  gates: WindowGates;
};

type EmployeeRunDriverContext = {
  session: TriggerSession;
  database: string;
  employeeId: string;
  resolveHandler: (reason: string) => TriggerHandler | undefined;
  gates: WindowGates;
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
      const trigger: TriggerEnvelope = { ...inputData, runId: inputData.runId ?? null };
      const output = await handler({
        trigger,
        session: runtime.session,
        effects: createEmployeeEffects(runtime.session, inputData.id),
        resumeData,
        suspend: suspend as (payload?: unknown) => Promise<never>,
        ...runtime.gates.forTrigger(trigger),
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
  type MastraRun = Awaited<ReturnType<typeof workflow.createRun>>;

  function jobContext(): RequestContext {
    const requestContext = new RequestContext();
    setExecutionContext(requestContext, { surrealSession: sessionAsDb });
    requestContext.set(EMPLOYEE_RUNTIME_KEY, {
      session: ctx.session,
      resolveHandler: ctx.resolveHandler,
      gates: ctx.gates,
    } satisfies EmployeeJobRuntime);
    return requestContext;
  }

  /**
   * 本驱动的中止状态机：一个驱动只承载一次 run（start / restart / resume 三选一）。
   * - idle / creating：中止记为 abortRequested，不丢失；run 创建后立即 cancel。
   *   createRun 尚未返回时到达的中止，abort() 的 promise 在取消完成后才结算。
   * - running：中止即 run.cancel()，同一 run 只取消一次（幂等）。
   * - finished：start/restart/resume 已返回（成功、失败或 suspended）；终态不再取消。
   */
  let phase: "idle" | "creating" | "running" | "finished" = "idle";
  let activeRun: MastraRun | null = null;
  let abortRequested = false;
  let cancelling: Promise<void> | undefined;
  let cancelSettled: Promise<void> | undefined;
  let settleCancelSettled: (() => void) | undefined;

  function cancelActiveRun(): Promise<void> {
    if (!activeRun) return Promise.resolve();
    cancelling ??= activeRun.cancel().catch((cause: unknown) => {
      // cancel 只终止执行并落 canceled snapshot；失败时触发仍靠 lease 回收兜底。
      console.warn("[employee-mastra-runner] run cancel failed", {
        message: cause instanceof Error ? cause.message : String(cause),
      });
    });
    return cancelling;
  }

  async function execute(
    createRun: () => Promise<MastraRun>,
    body: (run: MastraRun) => Promise<MastraRunResult>,
    // resume 的 run 可能处于 suspended（可恢复的等待态）：创建期间的中止只放弃本次恢复，不取消它。
    cancelIfAbortedWhileCreating = true,
  ): Promise<EmployeeRunResult> {
    if (phase !== "idle") throw new Error("employee-run-driver-reused");
    phase = "creating";
    let run: MastraRun;
    try {
      run = await createRun();
    } catch (cause) {
      phase = "finished";
      settleCancelSettled?.();
      throw cause;
    }
    activeRun = run;
    phase = "running";
    if (abortRequested) {
      // 中止在 createRun 期间到达：不再执行 body（否则 start 会把已取消的快照改回 running）。
      // start/restart 取消 run，快照落 canceled；resume 保留 suspended 快照，只放弃本次恢复。
      if (cancelIfAbortedWhileCreating) await cancelActiveRun();
      settleCancelSettled?.();
      phase = "finished";
      return { status: "failed", error: "window-aborted" };
    }
    const result = await body(run).then(
      (outcome) => {
        phase = "finished";
        return outcome;
      },
      (cause: unknown) => {
        phase = "finished";
        throw cause;
      },
    );
    return toRunResult(result);
  }

  async function abort(): Promise<void> {
    if (phase === "finished") return;
    abortRequested = true;
    if (phase === "running") {
      await cancelActiveRun();
      return;
    }
    if (phase === "creating") {
      cancelSettled ??= new Promise<void>((resolve) => {
        settleCancelSettled = resolve;
      });
      await cancelSettled;
    }
    // idle：尚未启动；后续 start 创建 run 后按 abortRequested 立即取消。
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
      return execute(
        () => workflow.createRun({ runId }),
        async (run) =>
          (await run.start({
            inputData: trigger,
            requestContext: jobContext(),
          })) as MastraRunResult,
      );
    },

    async restart({ runId }) {
      return execute(
        () => workflow.createRun({ runId }),
        async (run) => (await run.restart({ requestContext: jobContext() })) as MastraRunResult,
      );
    },

    async resume({ runId, resumeData }) {
      return execute(
        () => workflow.createRun({ runId }),
        async (run) =>
          (await run.resume({
            resumeData,
            requestContext: jobContext(),
          })) as MastraRunResult,
        false,
      );
    },

    abort,
  };
}
