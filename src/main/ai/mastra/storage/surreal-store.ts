import { MastraCompositeStore } from "@mastra/core/storage";
import { MemoryStorage } from "@mastra/core/storage";
import { ObservabilityStorage } from "@mastra/core/storage";
import { WorkflowsStorage } from "@mastra/core/storage";
import type { MastraDBMessage, StorageThreadType } from "@mastra/core/memory";
import type { StepResult, WorkflowRunState } from "@mastra/core/workflows";
import type {
  StorageListMessagesByResourceIdInput,
  StorageListMessagesInput,
  StorageListMessagesOutput,
  StorageListThreadsInput,
  StorageListThreadsOutput,
  StorageListWorkflowRunsInput,
  StorageResourceType,
  UpdateWorkflowStateOptions,
  WorkflowRun,
  WorkflowRuns,
} from "@mastra/core/storage";
import type {
  BatchCreateSpansArgs,
  BatchDeleteTracesArgs,
  BatchUpdateSpansArgs,
  CreateSpanArgs,
  GetRootSpanArgs,
  GetRootSpanResponse,
  GetSpanArgs,
  GetSpanResponse,
  GetSpansArgs,
  GetSpansResponse,
  GetStructureResponse,
  GetTraceArgs,
  GetTraceResponse,
  ListBranchesArgs,
  ListBranchesResponse,
  ListTracesArgs,
  ListTracesResponse,
  SpanRecord,
  TraceStatus,
} from "@mastra/core/storage";
import type {
  BatchCreateFeedbackArgs,
  BatchCreateLogsArgs,
  BatchCreateMetricsArgs,
  BatchCreateScoresArgs,
  CreateFeedbackArgs,
  CreateScoreArgs,
  GetEntityNamesResponse,
  GetEntityTypesResponse,
  GetEnvironmentsResponse,
  GetFeedbackAggregateResponse,
  GetFeedbackBreakdownResponse,
  GetFeedbackPercentilesResponse,
  GetFeedbackTimeSeriesResponse,
  GetMetricAggregateResponse,
  GetMetricBreakdownResponse,
  GetMetricLabelKeysResponse,
  GetMetricLabelValuesResponse,
  GetMetricNamesResponse,
  GetMetricPercentilesResponse,
  GetMetricTimeSeriesResponse,
  GetServiceNamesResponse,
  GetTagsResponse,
  ListFeedbackResponse,
  ListLogsResponse,
  ListMetricsResponse,
  ListScoresResponse,
  ScoreRecord,
} from "@mastra/core/storage";
import { RecordId } from "surrealdb";
import { getLocalDb } from "../../../db/index";
import { getObservabilitySettings, observabilityExpiry } from "../../../services/settings";

type MessageRow = {
  id: RecordId;
  message_id: string;
  thread_id: string;
  resource_id?: string;
  role: string;
  type: string;
  content: unknown;
  created_at: Date;
  updated_at?: Date;
};

type ThreadRow = {
  id: RecordId;
  thread_id: string;
  resource_id: string;
  title?: string;
  metadata?: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

type ResourceRow = {
  id: RecordId;
  resource_id: string;
  working_memory?: string;
  metadata?: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

type SpanRow = SpanRecord & {
  id: RecordId;
  expires_at?: Date;
};

type WorkflowRunRow = {
  id: RecordId;
  workflow_name: string;
  run_id: string;
  resource_id?: string;
  snapshot: WorkflowRunState | string;
  status: string;
  created_at: Date;
  updated_at: Date;
};

function rid(table: string, id: string): RecordId {
  const normalized = id.replace(/[^a-zA-Z0-9_:-]/g, "_");
  return new RecordId(table, normalized);
}

function normalizeDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") return new Date(value);
  return new Date();
}

function toThread(row: ThreadRow): StorageThreadType {
  return {
    id: row.thread_id,
    resourceId: row.resource_id,
    title: row.title,
    metadata: row.metadata,
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  };
}

function toResource(row: ResourceRow): StorageResourceType {
  return {
    id: row.resource_id,
    workingMemory: row.working_memory,
    metadata: row.metadata,
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  };
}

function toMessage(row: MessageRow): MastraDBMessage {
  return {
    ...(typeof row.content === "object" && row.content !== null ? (row.content as object) : {}),
    id: row.message_id,
    threadId: row.thread_id,
    resourceId: row.resource_id,
    role: row.role,
    type: row.type,
    createdAt: normalizeDate(row.created_at),
  } as MastraDBMessage;
}

function toSpan(row: SpanRow): SpanRecord {
  const { id: _id, expires_at: _expiresAt, ...span } = row;
  return {
    ...span,
    createdAt: normalizeDate(span.createdAt),
    updatedAt: span.updatedAt ? normalizeDate(span.updatedAt) : null,
    startedAt: normalizeDate(span.startedAt),
    endedAt: span.endedAt ? normalizeDate(span.endedAt) : span.endedAt,
  } as SpanRecord;
}

function traceStatus(span: SpanRecord): TraceStatus {
  if (span.error) return "error" as TraceStatus;
  if (!span.endedAt) return "running" as TraceStatus;
  return "success" as TraceStatus;
}

function lightSpan(span: SpanRecord) {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    spanType: span.spanType,
    isEvent: span.isEvent,
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    error: span.error,
    entityType: span.entityType,
    entityId: span.entityId,
    entityName: span.entityName,
    createdAt: span.createdAt,
    updatedAt: span.updatedAt,
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseWorkflowSnapshot(snapshot: WorkflowRunRow["snapshot"]): WorkflowRunState {
  return typeof snapshot === "string" ? JSON.parse(snapshot) as WorkflowRunState : cloneJson(snapshot);
}

function toWorkflowRun(row: WorkflowRunRow): WorkflowRun {
  return {
    workflowName: row.workflow_name,
    runId: row.run_id,
    resourceId: row.resource_id,
    snapshot: parseWorkflowSnapshot(row.snapshot),
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  };
}

function pagination(page = 0, perPage: number | false | undefined = 100, total = 0): {
  total: number;
  page: number;
  perPage: number | false;
  hasMore: boolean;
} {
  const normalized = perPage === false ? false : perPage ?? 100;
  const size = normalized === false ? total : normalized;
  return {
    total,
    page,
    perPage: normalized,
    hasMore: normalized !== false && (page + 1) * size < total,
  };
}

export class SurrealWorkflowsStorage extends WorkflowsStorage {
  supportsConcurrentUpdates(): boolean {
    return false;
  }

  async dangerouslyClearAll(): Promise<void> {
    await getLocalDb().query(`DELETE mastra_workflow_run;`);
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

    const existingResult = snapshot.context[stepId];
    if (
      existingResult &&
      "output" in existingResult &&
      Array.isArray(existingResult.output) &&
      result &&
      typeof result === "object" &&
      "output" in result &&
      Array.isArray(result.output)
    ) {
      const mergedOutput = [...existingResult.output];
      for (let i = 0; i < Math.max(existingResult.output.length, result.output.length); i += 1) {
        if (i < result.output.length && result.output[i] !== null) mergedOutput[i] = result.output[i];
      }
      snapshot.context[stepId] = { ...existingResult, ...result, output: mergedOutput };
    } else {
      snapshot.context[stepId] = result;
    }
    snapshot.requestContext = { ...snapshot.requestContext, ...requestContext };
    await this.persistWorkflowSnapshot({ workflowName, runId, snapshot, updatedAt: new Date() });
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
    await this.persistWorkflowSnapshot({ workflowName, runId, snapshot: next, updatedAt: new Date() });
    return next;
  }

  async persistWorkflowSnapshot({
    workflowName,
    runId,
    resourceId,
    snapshot,
    createdAt,
    updatedAt,
  }: {
    workflowName: string;
    runId: string;
    resourceId?: string;
    snapshot: WorkflowRunState;
    createdAt?: Date;
    updatedAt?: Date;
  }): Promise<void> {
    try {
      const existing = await this.getWorkflowRunById({ workflowName, runId });
      const now = new Date();
      await getLocalDb().query(
        `INSERT INTO mastra_workflow_run $content
         ON DUPLICATE KEY UPDATE
           resource_id = $input.resource_id,
           snapshot = $input.snapshot,
           status = $input.status,
           updated_at = $input.updated_at`,
        {
          content: {
            workflow_name: workflowName,
            run_id: runId,
            resource_id: resourceId,
            snapshot,
            status: snapshot.status,
            created_at: createdAt ?? existing?.createdAt ?? now,
            updated_at: updatedAt ?? now,
          },
        }
      );
    } catch (err) {
      console.warn("[mastra] failed to persist workflow snapshot; degraded to in-memory workflow state:", err);
    }
  }

  async loadWorkflowSnapshot({ workflowName, runId }: { workflowName: string; runId: string }): Promise<WorkflowRunState | null> {
    try {
      const rows = await getLocalDb().query<[WorkflowRunRow[]]>(
        `SELECT * FROM mastra_workflow_run WHERE workflow_name = $workflowName AND run_id = $runId LIMIT 1`,
        { workflowName, runId }
      );
      const row = rows[0]?.[0];
      return row?.snapshot ? parseWorkflowSnapshot(row.snapshot) : null;
    } catch (err) {
      console.warn("[mastra] failed to load workflow snapshot; degraded to in-memory workflow state:", err);
      return null;
    }
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
      if (args.fromDate) {
        where.push("created_at >= $fromDate");
        params.fromDate = args.fromDate;
      }
      if (args.toDate) {
        where.push("created_at <= $toDate");
        params.toDate = args.toDate;
      }
      if (args.resourceId) {
        where.push("resource_id = $resourceId");
        params.resourceId = args.resourceId;
      }
      if (args.status) {
        where.push("status = $status");
        params.status = args.status;
      }

      const usePagination = args.perPage !== undefined && args.page !== undefined;
      const perPage = args.perPage === false ? Number.MAX_SAFE_INTEGER : args.perPage;
      let query = `SELECT * FROM mastra_workflow_run WHERE ${where.join(" AND ")} ORDER BY created_at DESC`;
      if (usePagination) {
        params.start = args.page! * perPage!;
        params.limit = perPage;
        query += ` START $start LIMIT $limit`;
      }
      query += `;
       SELECT count() AS total FROM mastra_workflow_run WHERE ${where.join(" AND ")} GROUP ALL;`;

      const rows = await getLocalDb().query<[WorkflowRunRow[], { total?: number }[]]>(query, params);
      const runs = (rows[0] ?? []).map(toWorkflowRun);
      return { runs, total: rows[1]?.[0]?.total ?? runs.length };
    } catch (err) {
      console.warn("[mastra] failed to list workflow runs; degraded to in-memory workflow state:", err);
      return { runs: [], total: 0 };
    }
  }

  async getWorkflowRunById({ runId, workflowName }: { runId: string; workflowName?: string }): Promise<WorkflowRun | null> {
    try {
      const where = workflowName ? "workflow_name = $workflowName AND run_id = $runId" : "run_id = $runId";
      const rows = await getLocalDb().query<[WorkflowRunRow[]]>(
        `SELECT * FROM mastra_workflow_run WHERE ${where} LIMIT 1`,
        { workflowName, runId }
      );
      const row = rows[0]?.[0];
      return row ? toWorkflowRun(row) : null;
    } catch (err) {
      console.warn("[mastra] failed to get workflow run; degraded to in-memory workflow state:", err);
      return null;
    }
  }

  async deleteWorkflowRunById({ workflowName, runId }: { workflowName: string; runId: string }): Promise<void> {
    try {
      await getLocalDb().query(
        `DELETE mastra_workflow_run WHERE workflow_name = $workflowName AND run_id = $runId`,
        { workflowName, runId }
      );
    } catch (err) {
      console.warn("[mastra] failed to delete workflow run; degraded to in-memory workflow state:", err);
    }
  }
}

export class SurrealMemoryStorage extends MemoryStorage {
  async dangerouslyClearAll(): Promise<void> {
    await getLocalDb().query(`
      DELETE mastra_memory_message;
      DELETE mastra_memory_thread;
      DELETE mastra_memory_resource;
    `);
  }

  async getThreadById({ threadId }: { threadId: string }): Promise<StorageThreadType | null> {
    const rows = await getLocalDb().query<[ThreadRow[]]>(
      `SELECT * FROM mastra_memory_thread WHERE thread_id = $threadId LIMIT 1`,
      { threadId }
    );
    const row = rows[0]?.[0];
    return row ? toThread(row) : null;
  }

  async saveThread({ thread }: { thread: StorageThreadType }): Promise<StorageThreadType> {
    await getLocalDb().query(
      `UPSERT $id CONTENT {
        thread_id: $threadId,
        resource_id: $resourceId,
        title: $title,
        metadata: $metadata,
        created_at: $createdAt,
        updated_at: $updatedAt
      }`,
      {
        id: rid("mastra_memory_thread", thread.id),
        threadId: thread.id,
        resourceId: thread.resourceId,
        title: thread.title ?? null,
        metadata: thread.metadata ?? {},
        createdAt: thread.createdAt ?? new Date(),
        updatedAt: thread.updatedAt ?? new Date(),
      }
    );
    return thread;
  }

  async updateThread({
    id,
    title,
    metadata,
  }: {
    id: string;
    title: string;
    metadata: Record<string, unknown>;
  }): Promise<StorageThreadType> {
    const rows = await getLocalDb().query<[ThreadRow[]]>(
      `UPDATE mastra_memory_thread
       SET title = $title, metadata = $metadata, updated_at = time::now()
       WHERE thread_id = $id
       RETURN AFTER`,
      { id, title, metadata }
    );
    const row = rows[0]?.[0];
    if (!row) throw new Error(`[mastra] thread not found: ${id}`);
    return toThread(row);
  }

  async deleteThread({ threadId }: { threadId: string }): Promise<void> {
    await getLocalDb().query(
      `DELETE mastra_memory_message WHERE thread_id = $threadId;
       DELETE mastra_memory_thread WHERE thread_id = $threadId;`,
      { threadId }
    );
  }

  async listMessages(args: StorageListMessagesInput): Promise<StorageListMessagesOutput> {
    const threadIds = Array.isArray(args.threadId) ? args.threadId : [args.threadId];
    return this.listMessagesInternal({ ...args, threadIds, resourceId: args.resourceId });
  }

  async listMessagesByResourceId(args: StorageListMessagesByResourceIdInput): Promise<StorageListMessagesOutput> {
    return this.listMessagesInternal({ ...args, threadIds: null, resourceId: args.resourceId });
  }

  private async listMessagesInternal(args: {
    threadIds: string[] | null;
    resourceId?: string;
    page?: number;
    perPage?: number | false;
    orderBy?: { direction?: "ASC" | "DESC" };
    filter?: { dateRange?: { start?: Date; end?: Date; startExclusive?: boolean; endExclusive?: boolean } };
  }): Promise<StorageListMessagesOutput> {
    const page = args.page ?? 0;
    const perPage = args.perPage ?? 40;
    const limit = perPage === false ? 10000 : perPage;
    const start = perPage === false ? 0 : page * limit;
    const direction = args.orderBy?.direction === "DESC" ? "DESC" : "ASC";
    const where = ["true"];
    const params: Record<string, unknown> = { start, limit };

    if (args.threadIds) {
      where.push("thread_id IN $threadIds");
      params.threadIds = args.threadIds;
    }
    if (args.resourceId) {
      where.push("resource_id = $resourceId");
      params.resourceId = args.resourceId;
    }
    if (args.filter?.dateRange?.start) {
      where.push(`created_at ${args.filter.dateRange.startExclusive ? ">" : ">="} $startDate`);
      params.startDate = args.filter.dateRange.start;
    }
    if (args.filter?.dateRange?.end) {
      where.push(`created_at ${args.filter.dateRange.endExclusive ? "<" : "<="} $endDate`);
      params.endDate = args.filter.dateRange.end;
    }

    const rows = await getLocalDb().query<[MessageRow[], { total?: number }[]]>(
      `SELECT * FROM mastra_memory_message
       WHERE ${where.join(" AND ")}
       ORDER BY created_at ${direction}
       START $start LIMIT $limit;
       SELECT count() AS total FROM mastra_memory_message WHERE ${where.join(" AND ")} GROUP ALL;`,
      params
    );
    const messages = (rows[0] ?? []).map(toMessage);
    const total = rows[1]?.[0]?.total ?? messages.length;
    return { messages, ...pagination(page, perPage, total) };
  }

  async listMessagesById({ messageIds }: { messageIds: string[] }): Promise<{ messages: MastraDBMessage[] }> {
    const rows = await getLocalDb().query<[MessageRow[]]>(
      `SELECT * FROM mastra_memory_message WHERE message_id IN $messageIds ORDER BY created_at ASC`,
      { messageIds }
    );
    return { messages: (rows[0] ?? []).map(toMessage) };
  }

  async saveMessages(args: { messages: MastraDBMessage[] }): Promise<{ messages: MastraDBMessage[] }> {
    for (const message of args.messages) {
      await getLocalDb().query(
        `UPSERT $id CONTENT {
          message_id: $messageId,
          thread_id: $threadId,
          resource_id: $resourceId,
          role: $role,
          type: $type,
          content: $content,
          created_at: $createdAt,
          updated_at: time::now()
        }`,
        {
          id: rid("mastra_memory_message", message.id),
          messageId: message.id,
          threadId: message.threadId ?? "",
          resourceId: message.resourceId ?? null,
          role: (message as { role?: string }).role ?? "user",
          type: (message as { type?: string }).type ?? "text",
          content: message,
          createdAt: message.createdAt ?? new Date(),
        }
      );
    }
    return { messages: args.messages };
  }

  async updateMessages(args: { messages: (Partial<Omit<MastraDBMessage, "createdAt">> & { id: string })[] }): Promise<MastraDBMessage[]> {
    const updated: MastraDBMessage[] = [];
    for (const patch of args.messages) {
      const existing = await this.listMessagesById({ messageIds: [patch.id] });
      const next = { ...(existing.messages[0] ?? {}), ...patch } as MastraDBMessage;
      await this.saveMessages({ messages: [next] });
      updated.push(next);
    }
    return updated;
  }

  async deleteMessages(messageIds: string[]): Promise<void> {
    await getLocalDb().query(`DELETE mastra_memory_message WHERE message_id IN $messageIds`, { messageIds });
  }

  async listThreads(args: StorageListThreadsInput): Promise<StorageListThreadsOutput> {
    const page = args.page ?? 0;
    const perPage = args.perPage ?? 100;
    const limit = perPage === false ? 10000 : perPage;
    const start = perPage === false ? 0 : page * limit;
    const direction = args.orderBy?.direction === "ASC" ? "ASC" : "DESC";
    const where = ["true"];
    const params: Record<string, unknown> = { start, limit };

    if (args.filter?.resourceId) {
      where.push("resource_id = $resourceId");
      params.resourceId = args.filter.resourceId;
    }

    const rows = await getLocalDb().query<[ThreadRow[], { total?: number }[]]>(
      `SELECT * FROM mastra_memory_thread
       WHERE ${where.join(" AND ")}
       ORDER BY updated_at ${direction}
       START $start LIMIT $limit;
       SELECT count() AS total FROM mastra_memory_thread WHERE ${where.join(" AND ")} GROUP ALL;`,
      params
    );
    const threads = (rows[0] ?? []).map(toThread).filter((thread) => {
      if (!args.filter?.metadata) return true;
      return Object.entries(args.filter.metadata).every(([key, value]) => thread.metadata?.[key] === value);
    });
    const total = rows[1]?.[0]?.total ?? threads.length;
    return { threads, ...pagination(page, perPage, total) };
  }

  async getResourceById({ resourceId }: { resourceId: string }): Promise<StorageResourceType | null> {
    const rows = await getLocalDb().query<[ResourceRow[]]>(
      `SELECT * FROM mastra_memory_resource WHERE resource_id = $resourceId LIMIT 1`,
      { resourceId }
    );
    const row = rows[0]?.[0];
    return row ? toResource(row) : null;
  }

  async saveResource({ resource }: { resource: StorageResourceType }): Promise<StorageResourceType> {
    await getLocalDb().query(
      `UPSERT $id CONTENT {
        resource_id: $resourceId,
        working_memory: $workingMemory,
        metadata: $metadata,
        created_at: $createdAt,
        updated_at: $updatedAt
      }`,
      {
        id: rid("mastra_memory_resource", resource.id),
        resourceId: resource.id,
        workingMemory: resource.workingMemory ?? null,
        metadata: resource.metadata ?? {},
        createdAt: resource.createdAt ?? new Date(),
        updatedAt: resource.updatedAt ?? new Date(),
      }
    );
    return resource;
  }

  async updateResource({
    resourceId,
    workingMemory,
    metadata,
  }: {
    resourceId: string;
    workingMemory?: string;
    metadata?: Record<string, unknown>;
  }): Promise<StorageResourceType> {
    const existing = await this.getResourceById({ resourceId });
    const resource: StorageResourceType = {
      id: resourceId,
      workingMemory: workingMemory ?? existing?.workingMemory,
      metadata: metadata ?? existing?.metadata ?? {},
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
    };
    await this.saveResource({ resource });
    return resource;
  }
}

export class SurrealObservabilityStorage extends ObservabilityStorage {
  get observabilityStrategy() {
    return { preferred: "batch-with-updates" as const, supported: ["batch-with-updates" as const, "realtime" as const] };
  }

  async dangerouslyClearAll(): Promise<void> {
    await getLocalDb().query(`
      DELETE mastra_observability_span;
      DELETE mastra_observability_event_raw;
    `);
  }

  async createSpan({ span }: CreateSpanArgs): Promise<void> {
    await this.upsertSpan(span as SpanRecord);
  }

  async updateSpan({ traceId, spanId, ...patch }: BatchUpdateSpansArgs["records"][number] & { traceId: string; spanId: string }): Promise<void> {
    const rows = await getLocalDb().query<[SpanRow[]]>(
      `SELECT * FROM mastra_observability_span WHERE traceId = $traceId AND spanId = $spanId LIMIT 1`,
      { traceId, spanId }
    );
    const current = rows[0]?.[0] ? toSpan(rows[0][0]) : ({ traceId, spanId } as SpanRecord);
    await this.upsertSpan({ ...current, ...patch, traceId, spanId } as SpanRecord);
  }

  async batchCreateSpans({ records }: BatchCreateSpansArgs): Promise<void> {
    for (const span of records) await this.upsertSpan(span as SpanRecord);
  }

  async batchUpdateSpans({ records }: BatchUpdateSpansArgs): Promise<void> {
    for (const record of records) await this.updateSpan(record as BatchUpdateSpansArgs["records"][number] & { traceId: string; spanId: string });
  }

  async batchDeleteTraces({ traceIds }: BatchDeleteTracesArgs): Promise<void> {
    await getLocalDb().query(`DELETE mastra_observability_span WHERE traceId IN $traceIds`, { traceIds });
  }

  private async upsertSpan(span: SpanRecord): Promise<void> {
    const settings = await getObservabilitySettings();
    await getLocalDb().query(
      `UPSERT $id CONTENT $content`,
      {
        id: rid("mastra_observability_span", `${span.traceId}_${span.spanId}`),
        content: {
          ...span,
          user_id: span.userId ?? null,
          resource_id: span.resourceId ?? null,
          thread_id: span.threadId ?? null,
          agent_id: String(span.entityType ?? "") === "agent" ? span.entityId : null,
          workflow_id: String(span.entityType ?? "") === "workflow" ? span.entityId : null,
          workbook_id: (span.metadata?.workbook_id ?? span.attributes?.workbook_id ?? null) as unknown,
          createdAt: span.createdAt ?? new Date(),
          updatedAt: new Date(),
          expires_at: observabilityExpiry(settings.retentionDays),
        },
      }
    );
  }

  async getSpan(args: GetSpanArgs): Promise<GetSpanResponse | null> {
    const span = await this.findSpan(args.traceId, args.spanId);
    return span ? { span } : null;
  }

  async getSpans(args: GetSpansArgs): Promise<GetSpansResponse> {
    const rows = await getLocalDb().query<[SpanRow[]]>(
      `SELECT * FROM mastra_observability_span
       WHERE traceId = $traceId AND spanId IN $spanIds
       ORDER BY startedAt ASC`,
      args
    );
    return { traceId: args.traceId, spans: (rows[0] ?? []).map(toSpan) };
  }

  async getRootSpan(args: GetRootSpanArgs): Promise<GetRootSpanResponse | null> {
    const rows = await getLocalDb().query<[SpanRow[]]>(
      `SELECT * FROM mastra_observability_span
       WHERE traceId = $traceId AND parentSpanId = NONE
       ORDER BY startedAt ASC
       LIMIT 1`,
      args
    );
    const span = rows[0]?.[0] ? toSpan(rows[0][0]) : null;
    return span ? { span } : null;
  }

  async getTrace(args: GetTraceArgs): Promise<GetTraceResponse | null> {
    const rows = await getLocalDb().query<[SpanRow[]]>(
      `SELECT * FROM mastra_observability_span WHERE traceId = $traceId ORDER BY startedAt ASC`,
      args
    );
    const spans = (rows[0] ?? []).map(toSpan);
    return spans.length ? { traceId: args.traceId, spans } : null;
  }

  async getStructure(args: GetTraceArgs): Promise<GetStructureResponse | null> {
    const trace = await this.getTrace(args);
    return trace ? { traceId: args.traceId, spans: trace.spans.map(lightSpan) } : null;
  }

  async getTraceLight(args: GetTraceArgs): Promise<GetStructureResponse | null> {
    return this.getStructure(args);
  }

  async listTraces(args: ListTracesArgs): Promise<ListTracesResponse> {
    const page = Number(args.pagination?.page ?? 0);
    const perPage = Number(args.pagination?.perPage ?? 100);
    const start = page * perPage;
    const direction = args.orderBy?.direction === "ASC" ? "ASC" : "DESC";
    const where = ["parentSpanId = NONE"];
    const params: Record<string, unknown> = { start, limit: perPage };
    const filters = args.filters ?? {};

    for (const key of ["traceId", "resourceId", "threadId", "userId", "entityId", "entityType", "serviceName"] as const) {
      if (filters[key]) {
        where.push(`${key} = $${key}`);
        params[key] = filters[key];
      }
    }

    const rows = await getLocalDb().query<[SpanRow[], { total?: number }[]]>(
      `SELECT * FROM mastra_observability_span
       WHERE ${where.join(" AND ")}
       ORDER BY startedAt ${direction}
       START $start LIMIT $limit;
       SELECT count() AS total FROM mastra_observability_span WHERE ${where.join(" AND ")} GROUP ALL;`,
      params
    );
    const spans = (rows[0] ?? []).map(toSpan).map((span) => ({ ...span, status: traceStatus(span) }));
    const total = rows[1]?.[0]?.total ?? spans.length;
    return { spans, pagination: pagination(page, perPage, total) } as ListTracesResponse;
  }

  async listBranches(_args: ListBranchesArgs): Promise<ListBranchesResponse> {
    return { branches: [], pagination: pagination(0, 100, 0) } as ListBranchesResponse;
  }

  private async findSpan(traceId: string, spanId: string): Promise<SpanRecord | null> {
    const rows = await getLocalDb().query<[SpanRow[]]>(
      `SELECT * FROM mastra_observability_span WHERE traceId = $traceId AND spanId = $spanId LIMIT 1`,
      { traceId, spanId }
    );
    return rows[0]?.[0] ? toSpan(rows[0][0]) : null;
  }

  async batchCreateLogs(args: BatchCreateLogsArgs): Promise<void> {
    await this.saveRawEvent("logs", args);
  }
  async batchCreateMetrics(args: BatchCreateMetricsArgs): Promise<void> {
    await this.saveRawEvent("metrics", args);
  }
  async createScore(args: CreateScoreArgs): Promise<void> {
    await this.saveRawEvent("score", args);
  }
  async batchCreateScores(args: BatchCreateScoresArgs): Promise<void> {
    await this.saveRawEvent("scores", args);
  }
  async createFeedback(args: CreateFeedbackArgs): Promise<void> {
    await this.saveRawEvent("feedback", args);
  }
  async batchCreateFeedback(args: BatchCreateFeedbackArgs): Promise<void> {
    await this.saveRawEvent("feedback", args);
  }

  private async saveRawEvent(kind: string, payload: unknown): Promise<void> {
    const settings = await getObservabilitySettings();
    await getLocalDb().query(
      `CREATE mastra_observability_event_raw CONTENT {
        kind: $kind,
        payload: $payload,
        created_at: time::now(),
        expires_at: $expiresAt
      }`,
      { kind, payload, expiresAt: observabilityExpiry(settings.retentionDays) }
    );
  }

  async listLogs(): Promise<ListLogsResponse> { return { logs: [], pagination: pagination(0, 100, 0) } as ListLogsResponse; }
  async listMetrics(): Promise<ListMetricsResponse> { return { metrics: [], pagination: pagination(0, 100, 0) } as ListMetricsResponse; }
  async listScores(): Promise<ListScoresResponse> { return { scores: [], pagination: pagination(0, 100, 0) } as ListScoresResponse; }
  async listFeedback(): Promise<ListFeedbackResponse> { return { feedback: [], pagination: pagination(0, 100, 0) } as ListFeedbackResponse; }
  async getScoreById(): Promise<ScoreRecord | null> { return null; }
  async getMetricAggregate(): Promise<GetMetricAggregateResponse> { return { value: null } as GetMetricAggregateResponse; }
  async getMetricBreakdown(): Promise<GetMetricBreakdownResponse> { return { groups: [] } as GetMetricBreakdownResponse; }
  async getMetricTimeSeries(): Promise<GetMetricTimeSeriesResponse> { return { series: [] } as GetMetricTimeSeriesResponse; }
  async getMetricPercentiles(): Promise<GetMetricPercentilesResponse> { return { series: [] } as GetMetricPercentilesResponse; }
  async getMetricNames(): Promise<GetMetricNamesResponse> { return { names: [] } as GetMetricNamesResponse; }
  async getMetricLabelKeys(): Promise<GetMetricLabelKeysResponse> { return { keys: [] } as GetMetricLabelKeysResponse; }
  async getMetricLabelValues(): Promise<GetMetricLabelValuesResponse> { return { values: [] } as GetMetricLabelValuesResponse; }
  async getEntityTypes(): Promise<GetEntityTypesResponse> { return { entityTypes: [] } as GetEntityTypesResponse; }
  async getEntityNames(): Promise<GetEntityNamesResponse> { return { names: [] } as GetEntityNamesResponse; }
  async getServiceNames(): Promise<GetServiceNamesResponse> { return { serviceNames: [] } as GetServiceNamesResponse; }
  async getEnvironments(): Promise<GetEnvironmentsResponse> { return { environments: [] } as GetEnvironmentsResponse; }
  async getTags(): Promise<GetTagsResponse> { return { tags: [] } as GetTagsResponse; }
  async getFeedbackAggregate(): Promise<GetFeedbackAggregateResponse> { return { value: null } as GetFeedbackAggregateResponse; }
  async getFeedbackBreakdown(): Promise<GetFeedbackBreakdownResponse> { return { groups: [] } as GetFeedbackBreakdownResponse; }
  async getFeedbackTimeSeries(): Promise<GetFeedbackTimeSeriesResponse> { return { series: [] } as GetFeedbackTimeSeriesResponse; }
  async getFeedbackPercentiles(): Promise<GetFeedbackPercentilesResponse> { return { series: [] } as GetFeedbackPercentilesResponse; }
}

export class SurrealMastraStore extends MastraCompositeStore {
  stores = {
    memory: new SurrealMemoryStorage(),
    workflows: new SurrealWorkflowsStorage(),
    observability: new SurrealObservabilityStorage(),
  };

  constructor() {
    super({ id: "surreal-mastra-store", name: "SurrealMastraStore" });
  }
}
