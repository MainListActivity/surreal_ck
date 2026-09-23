import type {
  ActivationSummary,
  SharedActivationSummary,
} from "@surreal-ck/shared";
import { DateTime, StringRecordId } from "surrealdb";
import { getRootDatabaseSession } from "../db/root-connection";
import { toIsoDateTimeString, toStringRecordId } from "../db/surreal-values";
import { env } from "../env";
import type {
  ActivationSummaryCursor,
  ActivationSummaryStore,
  WorkspaceSummaryAuthority,
} from "./service";

type Queryable = { query(sql: string, params?: Record<string, unknown>): Promise<unknown> };
type SessionFactory = (database: string, namespace: string) => Promise<Queryable>;

type SummaryRow = Record<string, unknown>;

function rows(result: unknown): SummaryRow[] {
  return Array.isArray(result) && Array.isArray(result[0]) ? result[0] as SummaryRow[] : [];
}

function first(result: unknown): SummaryRow | null {
  return rows(result)[0] ?? null;
}

function recordString(value: unknown): string | null {
  return toStringRecordId(value)?.toString() ?? null;
}

function mapSummary(row: SummaryRow): SharedActivationSummary | null {
  const summaryId = recordString(row.id);
  const workspaceSlug = typeof row.workspace_slug === "string" ? row.workspace_slug : null;
  const status = row.status === "active" || row.status === "withdrawn" ? row.status : null;
  const updatedAt = toIsoDateTimeString(row.updated_at);
  if (!summaryId || !workspaceSlug || !status || !updatedAt) return null;
  return {
    summaryId,
    workspaceSlug,
    contractVersion: row.contract_version === "2" ? "2" : "1",
    status,
    summary: status === "active" && row.content && typeof row.content === "object"
      ? row.content as ActivationSummary
      : null,
    suppliedAt: toIsoDateTimeString(row.supplied_at),
    updatedAt,
    sourceTrust: "team_supplied",
  };
}

export class SurrealActivationSummaryStore implements ActivationSummaryStore {
  constructor(
    private readonly getSession: SessionFactory = getRootDatabaseSession,
    private readonly namespace = env.SURREAL_NS,
  ) {}

  async resolveAdmin(workspaceSlug: string, subject: string): Promise<WorkspaceSummaryAuthority | null> {
    const system = await this.getSession("_system", this.namespace);
    const workspaceRow = first(await system.query(
      `SELECT id, slug, db_name FROM workspace
       WHERE slug = $slug AND status = "active" LIMIT 1;`,
      { slug: workspaceSlug },
    ));
    const workspaceId = workspaceRow ? recordString(workspaceRow.id) : null;
    const dbName = workspaceRow && typeof workspaceRow.db_name === "string" ? workspaceRow.db_name : null;
    if (!workspaceId || !dbName) return null;

    const index = first(await system.query(
      `SELECT id FROM user_workspace_index
       WHERE workspace = $workspace AND subject = $subject AND role = "admin"
         AND disabled_at = NONE LIMIT 1;`,
      { workspace: new StringRecordId(workspaceId), subject },
    ));
    if (!index) return null;

    // 只回查身份表，不读取任何客户业务台账。
    const workspace = await this.getSession(dbName, this.namespace);
    const admin = first(await workspace.query(
      `SELECT id FROM user
       WHERE subject = $subject AND kind = "human" AND is_admin = true
         AND disabled_at = NONE LIMIT 1;`,
      { subject },
    ));
    return admin ? { workspaceId, workspaceSlug, dbName } : null;
  }

  async findIdempotent(workspaceId: string, idempotencyKey: string): Promise<SharedActivationSummary | null> {
    const db = await this.getSession("_system", this.namespace);
    const audit = first(await db.query(
      `SELECT summary.* FROM workspace_activation_summary_audit
       WHERE workspace = $workspace AND idempotency_key = $idempotencyKey LIMIT 1;`,
      { workspace: new StringRecordId(workspaceId), idempotencyKey },
    ));
    return audit ? mapSummary(audit) : null;
  }

  async share(input: Readonly<{
    authority: WorkspaceSummaryAuthority;
    actorSubject: string;
    summary: ActivationSummary;
    idempotencyKey: string;
  }>): Promise<SharedActivationSummary> {
    const db = await this.getSession("_system", this.namespace);
    const result = await db.query(
      `BEGIN TRANSACTION;
       LET $projection = (UPSERT workspace_activation_summary
         SET workspace = $workspace,
             workspace_slug = $workspaceSlug,
             contract_version = $contractVersion,
             dedupe_key = $dedupeKey,
             status = "active",
             content = $content,
             supplied_by_subject = $actorSubject,
             supplied_at = time::now(),
             updated_at = time::now()
         WHERE workspace = $workspace);
       INSERT INTO workspace_activation_summary_audit {
         summary: $projection[0].id,
         workspace: $workspace,
         action: "shared",
         actor_subject: $actorSubject,
         idempotency_key: $idempotencyKey
       } ON DUPLICATE KEY UPDATE occurred_at = occurred_at;
       RETURN $projection;
       COMMIT TRANSACTION;`,
      {
        workspace: new StringRecordId(input.authority.workspaceId),
        workspaceSlug: input.authority.workspaceSlug,
        contractVersion: input.summary.contractVersion,
        dedupeKey: input.summary.dedupeKey,
        content: input.summary,
        actorSubject: input.actorSubject,
        idempotencyKey: input.idempotencyKey,
      },
    );
    const resultSets = Array.isArray(result) ? result : [];
    const projectionSet = resultSets.find((value) => Array.isArray(value) && value.some((row) => row && typeof row === "object" && "workspace_slug" in row));
    const mapped = Array.isArray(projectionSet) ? mapSummary(projectionSet[0] as SummaryRow) : null;
    if (!mapped) throw new Error("activation summary projection write returned no row");
    return mapped;
  }

  async withdraw(input: Readonly<{
    authority: WorkspaceSummaryAuthority;
    actorSubject: string;
    idempotencyKey: string;
  }>): Promise<SharedActivationSummary> {
    const db = await this.getSession("_system", this.namespace);
    const result = await db.query(
      `BEGIN TRANSACTION;
       LET $projection = (UPDATE workspace_activation_summary
         SET status = "withdrawn",
             content = NONE,
             supplied_by_subject = NONE,
             supplied_at = NONE,
             updated_at = time::now()
         WHERE workspace = $workspace);
       INSERT INTO workspace_activation_summary_audit {
         summary: $projection[0].id,
         workspace: $workspace,
         action: "withdrawn",
         actor_subject: $actorSubject,
         idempotency_key: $idempotencyKey
       } ON DUPLICATE KEY UPDATE occurred_at = occurred_at;
       RETURN $projection;
       COMMIT TRANSACTION;`,
      {
        workspace: new StringRecordId(input.authority.workspaceId),
        actorSubject: input.actorSubject,
        idempotencyKey: input.idempotencyKey,
      },
    );
    const resultSets = Array.isArray(result) ? result : [];
    const projectionSet = resultSets.find((value) => Array.isArray(value) && value.some((row) => row && typeof row === "object" && "workspace_slug" in row));
    const mapped = Array.isArray(projectionSet) ? mapSummary(projectionSet[0] as SummaryRow) : null;
    if (!mapped) throw new Error("activation summary withdrawal returned no row");
    return mapped;
  }

  async list(input: Readonly<{ limit: number; cursor: ActivationSummaryCursor | null; workspaceSlugs?: readonly string[] | null }>): Promise<SharedActivationSummary[]> {
    const db = await this.getSession("_system", this.namespace);
    const cursorClause = input.cursor
      ? `AND (updated_at < $cursorUpdatedAt
           OR (updated_at = $cursorUpdatedAt AND id < $cursorId))`
      : "";
    const params: Record<string, unknown> = { limit: input.limit };
    const scopeClause = input.workspaceSlugs ? "AND workspace_slug INSIDE $workspaceSlugs" : "";
    if (input.workspaceSlugs) params.workspaceSlugs = [...input.workspaceSlugs];
    if (input.cursor) {
      params.cursorUpdatedAt = new DateTime(input.cursor.updatedAt);
      params.cursorId = new StringRecordId(input.cursor.summaryId);
    }
    return rows(await db.query(
      `SELECT * FROM workspace_activation_summary
       WHERE status = "active" ${scopeClause} ${cursorClause}
       ORDER BY updated_at DESC, id DESC LIMIT $limit;`,
      params,
    )).map(mapSummary).filter((value): value is SharedActivationSummary => value !== null);
  }

  async get(summaryId: string): Promise<SharedActivationSummary | null> {
    const db = await this.getSession("_system", this.namespace);
    const row = first(await db.query("SELECT * FROM $summary LIMIT 1;", {
      summary: new StringRecordId(summaryId),
    }));
    return row ? mapSummary(row) : null;
  }
}
