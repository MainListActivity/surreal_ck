import { WorkflowsStorage } from "@mastra/core/storage";
import type {
  StorageListWorkflowRunsInput,
  UpdateWorkflowStateOptions,
  WorkflowRun,
  WorkflowRuns,
} from "@mastra/core/storage";
import type { StepResult, WorkflowRunState } from "@mastra/core/workflows";
import type { Surreal } from "surrealdb";

/**
 * 解析出当前 workflow 运行所用的 SurrealDB 会话及调用者 subject。
 * workflow_run.owner_user 由 workspace schema 的 DEFAULT $auth 归因，storage 不手写 owner_user。
 */
export type SurrealSessionResolver = () => { db: Surreal; subject: string };

/** workflow_run 表里 storage 关心的列（owner_user / created_at 由 DB 维护，不在此手写）。 */
type WorkflowRunRow = {
  run_id: string;
  workflow_name: string;
  resource_id?: string;
  kind: string;
  state: WorkflowRunState | string;
  status: string;
  created_at: Date;
  updated_at: Date;
};

const VALID_KINDS = new Set(["router", "office-employee"]);

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseState(state: WorkflowRunRow["state"]): WorkflowRunState {
  return typeof state === "string" ? (JSON.parse(state) as WorkflowRunState) : cloneJson(state);
}

function normalizeDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") return new Date(value);
  return new Date();
}

function toWorkflowRun(row: WorkflowRunRow): WorkflowRun {
  return {
    workflowName: row.workflow_name,
    runId: row.run_id,
    resourceId: row.resource_id,
    snapshot: parseState(row.state),
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  };
}

/** Mastra 不在 storage 层提供运行类型；当前只有 Router workflow，员工 workflow 由簇 E 另行标记。 */
function resolveKind(workflowName: string): string {
  return VALID_KINDS.has(workflowName) ? workflowName : "router";
}

/**
 * 把 Mastra WorkflowsStorage 落到当前 workspace database 的 workflow_run 表。
 * 所有读写走注入的调用者会话；写入失败必须抛回 workflow 引擎，让 RunBus 能把错误传给前端。
 */
export class SurrealWorkflowsStorage extends WorkflowsStorage {
  constructor(private readonly getSession: SurrealSessionResolver) {
    super();
  }

  supportsConcurrentUpdates(): boolean {
    return false;
  }

  async dangerouslyClearAll(): Promise<void> {
    const { db } = this.getSession();
    await db.query("DELETE workflow_run;");
  }

  async persistWorkflowSnapshot({
    workflowName,
    runId,
    resourceId,
    snapshot,
  }: {
    workflowName: string;
    runId: string;
    resourceId?: string;
    snapshot: WorkflowRunState;
    createdAt?: Date;
    updatedAt?: Date;
  }): Promise<void> {
    try {
      const { db } = this.getSession();
      // 唯一索引在 run_id 上，按规约用 INSERT ... ON DUPLICATE KEY UPDATE 处理冲突。
      await db.query(
        `INSERT INTO workflow_run $content
         ON DUPLICATE KEY UPDATE
           workflow_name = $input.workflow_name,
           resource_id = $input.resource_id,
           kind = $input.kind,
           state = $input.state,
           status = $input.status,
           updated_at = time::now()`,
        {
          content: {
            run_id: runId,
            workflow_name: workflowName,
            resource_id: resourceId ?? null,
            kind: resolveKind(workflowName),
            state: snapshot,
            status: snapshot.status,
          },
        },
      );
    } catch (err) {
      const causeMessage = err instanceof Error ? err.message : String(err);
      console.warn("[mastra] persist workflow snapshot 失败", {
        workflowName,
        runId,
        status: snapshot.status,
        message: causeMessage,
      });
      throw new Error(`persist workflow snapshot failed for workflow=${workflowName} run=${runId}: ${causeMessage}`, {
        cause: err,
      });
    }
  }

  async loadWorkflowSnapshot({
    workflowName,
    runId,
  }: {
    workflowName: string;
    runId: string;
  }): Promise<WorkflowRunState | null> {
    try {
      const { db } = this.getSession();
      const rows = await db.query<[WorkflowRunRow[]]>(
        `SELECT * FROM workflow_run WHERE run_id = $runId AND workflow_name = $workflowName LIMIT 1`,
        { runId, workflowName },
      );
      const row = rows[0]?.[0];
      return row?.state ? parseState(row.state) : null;
    } catch (err) {
      console.warn("[mastra] load workflow snapshot 失败，降级为内存态:", err);
      return null;
    }
  }

  async updateWorkflowResults({
    workflowName,
    runId,
    stepId,
    result,
    requestContext,
  }: {
    workflowName: string;
    runId: string;
    stepId: string;
    result: StepResult<any, any, any, any>;
    requestContext: Record<string, any>;
  }): Promise<Record<string, StepResult<any, any, any, any>>> {
    const snapshot = await this.loadWorkflowSnapshot({ workflowName, runId });
    if (!snapshot) return {};

    const existing = snapshot.context[stepId];
    if (
      existing &&
      "output" in existing &&
      Array.isArray((existing as { output?: unknown }).output) &&
      result &&
      typeof result === "object" &&
      "output" in result &&
      Array.isArray((result as { output?: unknown }).output)
    ) {
      const existingOutput = (existing as { output: unknown[] }).output;
      const resultOutput = (result as { output: unknown[] }).output;
      const merged = [...existingOutput];
      for (let i = 0; i < Math.max(existingOutput.length, resultOutput.length); i += 1) {
        if (i < resultOutput.length && resultOutput[i] !== null) merged[i] = resultOutput[i];
      }
      snapshot.context[stepId] = { ...existing, ...result, output: merged };
    } else {
      snapshot.context[stepId] = result;
    }
    snapshot.requestContext = { ...snapshot.requestContext, ...requestContext };
    await this.persistWorkflowSnapshot({ workflowName, runId, snapshot });
    return cloneJson(snapshot.context as Record<string, StepResult<any, any, any, any>>);
  }

  async updateWorkflowState({
    workflowName,
    runId,
    opts,
  }: {
    workflowName: string;
    runId: string;
    opts: UpdateWorkflowStateOptions;
  }): Promise<WorkflowRunState | undefined> {
    const snapshot = await this.loadWorkflowSnapshot({ workflowName, runId });
    if (!snapshot) return undefined;
    const next = { ...snapshot, ...opts };
    await this.persistWorkflowSnapshot({ workflowName, runId, snapshot: next });
    return next;
  }

  async listWorkflowRuns(args: StorageListWorkflowRunsInput = {}): Promise<WorkflowRuns> {
    if (args.page !== undefined && args.page < 0) throw new Error("page must be >= 0");
    try {
      const where = ["true"];
      const params: Record<string, unknown> = {};
      if (args.workflowName) {
        where.push("workflow_name = $workflowName");
        params.workflowName = args.workflowName;
      }
      if (args.status) {
        where.push("status = $status");
        params.status = args.status;
      }
      if (args.resourceId) {
        where.push("resource_id = $resourceId");
        params.resourceId = args.resourceId;
      }
      if (args.fromDate) {
        where.push("created_at >= $fromDate");
        params.fromDate = args.fromDate;
      }
      if (args.toDate) {
        where.push("created_at <= $toDate");
        params.toDate = args.toDate;
      }

      const usePagination = args.perPage !== undefined && args.perPage !== false && args.page !== undefined;
      let sql = `SELECT * FROM workflow_run WHERE ${where.join(" AND ")} ORDER BY created_at DESC`;
      if (usePagination) {
        params.start = args.page! * (args.perPage as number);
        params.limit = args.perPage as number;
        sql += " START $start LIMIT $limit";
      }
      sql += `;
       SELECT count() AS total FROM workflow_run WHERE ${where.join(" AND ")} GROUP ALL;`;

      const { db } = this.getSession();
      const rows = await db.query<[WorkflowRunRow[], { total?: number }[]]>(sql, params);
      const runs = (rows[0] ?? []).map(toWorkflowRun);
      return { runs, total: rows[1]?.[0]?.total ?? runs.length };
    } catch (err) {
      console.warn("[mastra] list workflow runs 失败，降级为空集:", err);
      return { runs: [], total: 0 };
    }
  }

  async getWorkflowRunById({
    runId,
    workflowName,
  }: {
    runId: string;
    workflowName?: string;
  }): Promise<WorkflowRun | null> {
    try {
      const { db } = this.getSession();
      const clause = workflowName ? "run_id = $runId AND workflow_name = $workflowName" : "run_id = $runId";
      const rows = await db.query<[WorkflowRunRow[]]>(
        `SELECT * FROM workflow_run WHERE ${clause} LIMIT 1`,
        { runId, workflowName },
      );
      const row = rows[0]?.[0];
      return row ? toWorkflowRun(row) : null;
    } catch (err) {
      console.warn("[mastra] get workflow run 失败:", err);
      return null;
    }
  }

  async deleteWorkflowRunById({ workflowName, runId }: { workflowName: string; runId: string }): Promise<void> {
    try {
      const { db } = this.getSession();
      await db.query(
        `DELETE workflow_run WHERE run_id = $runId AND workflow_name = $workflowName`,
        { runId, workflowName },
      );
    } catch (err) {
      console.warn("[mastra] delete workflow run 失败:", err);
    }
  }
}
