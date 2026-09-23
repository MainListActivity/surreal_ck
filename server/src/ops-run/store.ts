import { saveOpsRunSchema, type OpsRun, type SaveOpsRun } from "@surreal-ck/shared";
import { DateTime, StringRecordId } from "surrealdb";
import { getRootDatabaseSession } from "../db/root-connection";
import { toIsoDateTimeString, toStringRecordId } from "../db/surreal-values";
import { env } from "../env";
import type { OpsRunStore } from "./service";

type Queryable = { query(sql: string, params?: Record<string, unknown>): Promise<unknown> };
type SessionFactory = (database: string, namespace: string) => Promise<Queryable>;
type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => Array.isArray(value) && Array.isArray(value[0]) ? value[0] as Row[] : [];
const first = (value: unknown): Row | null => rows(value)[0] ?? null;
function mapRun(row: Row): OpsRun | null {
  const runId = toStringRecordId(row.id)?.toString();
  const updatedAt = toIsoDateTimeString(row.updated_at);
  const parsed = saveOpsRunSchema.safeParse({
    runKey: row.run_key, workspaceSlug: row.workspace_slug, expectedVersion: typeof row.version === "number" ? row.version - 1 : null,
    status: row.status, cursor: row.cursor ?? null, processedIds: row.processed_ids,
    pendingAction: row.pending_action ?? null, dueCheckAt: toIsoDateTimeString(row.due_check_at),
    retryCount: row.retry_count, lastErrorCode: row.last_error_code ?? null, actionsCompleted: row.actions_completed,
  });
  if (!runId || !updatedAt || typeof row.agent_subject !== "string" || typeof row.version !== "number" || !parsed.success) return null;
  return { ...parsed.data, expectedVersion: row.version - 1, runId, agentSubject: row.agent_subject, version: row.version, updatedAt };
}
export class SurrealOpsRunStore implements OpsRunStore {
  constructor(private readonly getSession: SessionFactory = getRootDatabaseSession, private readonly namespace = env.SURREAL_NS) {}
  private async db() { return await this.getSession("_system", this.namespace); }
  async get(agentSubject: string, workspaceSlug: string, runKey: string): Promise<OpsRun | null> {
    const row = first(await (await this.db()).query(`SELECT * FROM ops_agent_run WHERE agent_subject = $agentSubject
      AND workspace_slug = $workspaceSlug AND run_key = $runKey LIMIT 1;`, { agentSubject, workspaceSlug, runKey }));
    return row ? mapRun(row) : null;
  }
  async list(): Promise<OpsRun[]> {
    return rows(await (await this.db()).query(`SELECT * FROM ops_agent_run ORDER BY updated_at DESC LIMIT 200;`))
      .map(mapRun).filter((row): row is OpsRun => row !== null);
  }
  async save(agentSubject: string, input: SaveOpsRun): Promise<OpsRun | null> {
    const db = await this.db();
    const fields = { agentSubject, workspaceSlug: input.workspaceSlug, runKey: input.runKey, status: input.status,
      cursor: input.cursor ?? undefined, processedIds: input.processedIds, pendingAction: input.pendingAction ?? undefined,
      dueCheckAt: input.dueCheckAt ? new DateTime(input.dueCheckAt) : undefined,
      retryCount: input.retryCount, lastErrorCode: input.lastErrorCode ?? undefined, actionsCompleted: input.actionsCompleted };
    if (input.expectedVersion === null) {
      const result = await db.query(`INSERT INTO ops_agent_run { agent_subject: $agentSubject, workspace_slug: $workspaceSlug,
        run_key: $runKey, status: $status, cursor: $cursor, processed_ids: $processedIds,
        pending_action: $pendingAction, due_check_at: $dueCheckAt, retry_count: $retryCount,
        last_error_code: $lastErrorCode, actions_completed: $actionsCompleted, version: 1 }
        ON DUPLICATE KEY UPDATE agent_subject = agent_subject RETURN AFTER;`, fields);
      const item = mapRun(first(result) ?? {});
      return item?.version === 1 ? item : null;
    }
    const current = await this.get(agentSubject, input.workspaceSlug, input.runKey);
    if (!current) return null;
    const result = await db.query(`UPDATE $run SET status = $status, cursor = $cursor, processed_ids = $processedIds,
      pending_action = $pendingAction, due_check_at = $dueCheckAt, retry_count = $retryCount,
      last_error_code = $lastErrorCode, actions_completed = $actionsCompleted, version += 1, updated_at = time::now()
      WHERE agent_subject = $agentSubject AND workspace_slug = $workspaceSlug AND run_key = $runKey
        AND version = $expectedVersion RETURN AFTER;`, { ...fields, run: new StringRecordId(current.runId), expectedVersion: input.expectedVersion });
    return mapRun(first(result) ?? {});
  }
}
