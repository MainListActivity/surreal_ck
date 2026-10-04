import { StringRecordId } from "surrealdb";
import { getRootDatabaseSession } from "../db/root-connection";
import { toIsoDateTimeString } from "../db/surreal-values";

type Queryable = {
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

type Row = Record<string, unknown>;

const rows = (v: unknown): Row[] =>
  Array.isArray(v) && Array.isArray(v[0]) ? (v[0] as Row[]) : [];

export type InviteOutcome = Readonly<{
  idpUserId: string;
  idpUserStatus: string;
  userOutcome: "created" | "reused";
  workspaceDb: string;
  workspaceOutcome: "created" | "reused";
  productRevision: string;
  contentAssigned: boolean;
  aiAllowance: {
    kind: string;
    amount: number;
    periodKey: string;
    expiresAt: string;
    bucket: string | null;
  };
  deliveryChannel: "activation_url" | "none";
  activationUrlIssued: boolean;
}>;

export type InviteAuditRow = Readonly<{
  id: string;
  idempotencyKey: string;
  operatorSubject: string;
  email: string;
  displayName: string;
  workspaceSlug: string;
  workspaceName: string;
  planKey: string;
  reason: string;
  requestDigest: string;
  status: "processing" | "completed" | "failed";
  outcome: InviteOutcome | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string | null;
  completedAt: string | null;
}>;

export type InviteClaimInsert = Readonly<{
  recordId: string;
  idempotencyKey: string;
  operatorSubject: string;
  authorizedCapability: string;
  email: string;
  displayName: string;
  workspaceSlug: string;
  workspaceName: string;
  planKey: string;
  reason: string;
  requestDigest: string;
}>;

export type WorkspaceIndexRow = Readonly<{
  ownerSubject: string | null;
  dbName: string | null;
  status: string;
}>;

export interface InviteAuditStore {
  /** CREATE ONLY 占位；幂等键冲突时返回既有行。 */
  claim(input: InviteClaimInsert): Promise<{ kind: "claimed" } | { kind: "existing"; row: InviteAuditRow }>;
  complete(recordId: string, outcome: InviteOutcome): Promise<void>;
  fail(recordId: string, code: string, message: string): Promise<void>;
  byKey(idempotencyKey: string): Promise<InviteAuditRow | null>;
  /** slug 冲突时判别「同一邀请人名下复用」还是「他人占用」。 */
  workspaceBySlug(slug: string): Promise<WorkspaceIndexRow | null>;
}

function parseOutcome(row: Row): InviteOutcome | null {
  const ai = row.ai_allowance;
  if (
    typeof row.idp_user_id !== "string"
    || typeof row.idp_user_status !== "string"
    || (row.user_outcome !== "created" && row.user_outcome !== "reused")
    || typeof row.workspace_db !== "string"
    || (row.workspace_outcome !== "created" && row.workspace_outcome !== "reused")
    || typeof row.product_revision !== "string"
    || !ai || typeof ai !== "object"
  ) {
    return null;
  }
  const allowance = ai as Record<string, unknown>;
  return {
    idpUserId: row.idp_user_id,
    idpUserStatus: row.idp_user_status,
    userOutcome: row.user_outcome,
    workspaceDb: row.workspace_db,
    workspaceOutcome: row.workspace_outcome,
    productRevision: row.product_revision,
    contentAssigned: row.content_assigned === true,
    aiAllowance: {
      kind: typeof allowance.kind === "string" ? allowance.kind : "",
      amount: typeof allowance.amount === "number" ? allowance.amount : 0,
      periodKey: typeof allowance.period_key === "string" ? allowance.period_key : "",
      expiresAt: toIsoDateTimeString(allowance.expires_at) ?? "",
      bucket: typeof allowance.bucket === "string" ? allowance.bucket : null,
    },
    deliveryChannel: row.delivery_channel === "activation_url" ? "activation_url" : "none",
    activationUrlIssued: row.activation_url_issued === true,
  };
}

function parseRow(row: Row): InviteAuditRow {
  return {
    id: String(row.id),
    idempotencyKey: String(row.idempotency_key),
    operatorSubject: String(row.operator_subject),
    email: String(row.email),
    displayName: String(row.display_name),
    workspaceSlug: String(row.workspace_slug),
    workspaceName: String(row.workspace_name),
    planKey: String(row.plan_key),
    reason: String(row.reason),
    requestDigest: String(row.request_digest),
    status: row.status === "completed" ? "completed" : row.status === "failed" ? "failed" : "processing",
    outcome: parseOutcome(row),
    errorCode: typeof row.error_code === "string" ? row.error_code : null,
    errorMessage: typeof row.error_message === "string" ? row.error_message : null,
    createdAt: toIsoDateTimeString(row.created_at),
    completedAt: toIsoDateTimeString(row.completed_at),
  };
}

export class SurrealInviteAuditStore implements InviteAuditStore {
  constructor(
    private readonly session: (database: string, namespace?: string) => Promise<Queryable> = getRootDatabaseSession,
    private readonly database = "_system",
  ) {}

  async claim(input: InviteClaimInsert) {
    const db = await this.session(this.database);
    try {
      await db.query(
        `CREATE ONLY $id CONTENT {
          idempotency_key: $key, operator_subject: $operator, authorized_capability: $cap,
          email: $email, display_name: $displayName, workspace_slug: $slug, workspace_name: $wsName,
          plan_key: $plan, reason: $reason, request_digest: $digest,
          status: "processing", activation_url_issued: false, created_at: time::now()
        };`,
        {
          id: new StringRecordId(input.recordId),
          key: input.idempotencyKey,
          operator: input.operatorSubject,
          cap: input.authorizedCapability,
          email: input.email,
          displayName: input.displayName,
          slug: input.workspaceSlug,
          wsName: input.workspaceName,
          plan: input.planKey,
          reason: input.reason,
          digest: input.requestDigest,
        },
      );
      return { kind: "claimed" as const };
    } catch {
      const existing = await this.byKey(input.idempotencyKey);
      if (existing) return { kind: "existing" as const, row: existing };
      // 唯一索引竞争但行未读回（极窄窗口）：让调用方按失败处理可重试。
      throw new Error("ops-invitation-claim-conflict-unresolved");
    }
  }

  async complete(recordId: string, outcome: InviteOutcome): Promise<void> {
    const db = await this.session(this.database);
    await db.query(
      `UPDATE $id SET
        status = "completed", completed_at = time::now(),
        idp_user_id = $userId, idp_user_status = $userStatus, user_outcome = $userOutcome,
        workspace_db = $dbName, workspace_outcome = $wsOutcome,
        product_revision = $revision, content_assigned = $assigned,
        ai_allowance = { kind: $aiKind, amount: $aiAmount, period_key: $aiPeriod, expires_at: $aiExpires, bucket: $aiBucket },
        delivery_channel = $channel, activation_url_issued = $issued;`,
      {
        id: new StringRecordId(recordId),
        userId: outcome.idpUserId,
        userStatus: outcome.idpUserStatus,
        userOutcome: outcome.userOutcome,
        dbName: outcome.workspaceDb,
        wsOutcome: outcome.workspaceOutcome,
        revision: outcome.productRevision,
        assigned: outcome.contentAssigned,
        aiKind: outcome.aiAllowance.kind,
        aiAmount: outcome.aiAllowance.amount,
        aiPeriod: outcome.aiAllowance.periodKey,
        aiExpires: new Date(outcome.aiAllowance.expiresAt),
        aiBucket: outcome.aiAllowance.bucket,
        channel: outcome.deliveryChannel,
        issued: outcome.activationUrlIssued,
      },
    );
  }

  async fail(recordId: string, code: string, message: string): Promise<void> {
    const db = await this.session(this.database);
    await db.query(
      `UPDATE $id SET status = "failed", error_code = $code, error_message = $message, completed_at = time::now();`,
      { id: new StringRecordId(recordId), code, message: message.slice(0, 500) },
    );
  }

  async byKey(idempotencyKey: string): Promise<InviteAuditRow | null> {
    const db = await this.session(this.database);
    const row = rows(
      await db.query(
        "SELECT * FROM ops_invitation WHERE idempotency_key = $key LIMIT 1;",
        { key: idempotencyKey },
      ),
    )[0];
    return row ? parseRow(row) : null;
  }

  async workspaceBySlug(slug: string): Promise<WorkspaceIndexRow | null> {
    const db = await this.session(this.database);
    const row = rows(
      await db.query(
        "SELECT owner_subject, db_name, status FROM workspace WHERE slug = $slug LIMIT 1;",
        { slug },
      ),
    )[0];
    if (!row) return null;
    return {
      ownerSubject: typeof row.owner_subject === "string" ? row.owner_subject : row.owner_subject ? String(row.owner_subject) : null,
      dbName: typeof row.db_name === "string" ? row.db_name : null,
      status: String(row.status),
    };
  }
}
