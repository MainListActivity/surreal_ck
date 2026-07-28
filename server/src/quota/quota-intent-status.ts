import {
  QUOTA_API_FORMAT_VERSION,
  type QuotaOperatorIntentKind,
  type QuotaOperatorIntentStatusView,
} from "@surreal-ck/shared/native-quota";
import { StringRecordId } from "surrealdb";
import { getRootDatabaseSession } from "../db/root-connection";
import {
  toIsoDateTimeString,
  toStringRecordId,
} from "../db/surreal-values";

type Queryable = {
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

export interface QuotaIntentStatusReader {
  get(input: Readonly<{
    intent: StringRecordId;
    actorSubject: string;
  }>): Promise<QuotaOperatorIntentStatusView | null>;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstRow(result: unknown): UnknownRecord | undefined {
  if (!Array.isArray(result)) return undefined;
  const statement = result[0];
  if (Array.isArray(statement)) return statement.find(isRecord);
  return isRecord(statement) ? statement : undefined;
}

function values(result: unknown): unknown[] {
  if (!Array.isArray(result)) return [];
  return Array.isArray(result[0]) ? result[0] : [];
}

function intentKind(value: unknown): QuotaOperatorIntentKind | null {
  const allowed = new Set<QuotaOperatorIntentKind>([
    "subscription_upsert",
    "subscription_end",
    "override_schedule",
    "override_end",
    "reconcile_now",
    "audit_now",
    "drift_reapply",
    "drift_to_override",
    "ledger_rebuild",
    "materialization_retry",
    "provisioning_retry",
    "provisioning_cleanup",
    "auto_reconcile_pause",
    "auto_reconcile_resume",
  ]);
  return typeof value === "string" && allowed.has(value as QuotaOperatorIntentKind)
    ? value as QuotaOperatorIntentKind
    : null;
}

function state(
  value: unknown,
): QuotaOperatorIntentStatusView["state"] | null {
  return value === "scheduled"
    || value === "pending"
    || value === "processing"
    || value === "processed"
    || value === "failed"
    || value === "terminal_failed"
    ? value
    : null;
}

function count(value: unknown): number | string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  return null;
}

export class SurrealQuotaIntentStatusReader implements QuotaIntentStatusReader {
  private readonly getDb: () => Promise<Queryable>;

  constructor(options: Readonly<{
    db?: Queryable;
    getDb?: () => Promise<Queryable>;
  }> = {}) {
    this.getDb = options.db
      ? async () => options.db!
      : options.getDb ?? (() => getRootDatabaseSession("_system"));
  }

  async get(input: Readonly<{
    intent: StringRecordId;
    actorSubject: string;
  }>): Promise<QuotaOperatorIntentStatusView | null> {
    const db = await this.getDb();
    const intentResult = await db.query(
      "SELECT intent_kind, actor_subject FROM ONLY $intent;",
      { intent: input.intent },
    );
    const intent = firstRow(intentResult);
    if (!intent) return null;
    const owns = intent.actor_subject === input.actorSubject;
    if (!owns) {
      const capabilityResult = await db.query(
        `
          SELECT VALUE capability
          FROM platform_operator_capability
          WHERE capability = "quota.read"
            AND status = "active"
            AND operator IN (
              SELECT VALUE id
              FROM platform_operator
              WHERE subject = $subject
                AND status = "active"
            )
          LIMIT 1;
        `,
        { subject: input.actorSubject },
      );
      if (!values(capabilityResult).includes("quota.read")) return null;
    }

    const stateResult = await db.query(
      `
        SELECT *
        FROM ONLY quota_operator_intent_state
        WHERE intent = $intent;
      `,
      { intent: input.intent },
    );
    const current = firstRow(stateResult);
    const kind = intentKind(intent.intent_kind);
    const currentState = state(current?.state);
    const attempts = count(current?.attempt_count);
    const updatedAt = toIsoDateTimeString(current?.updated_at);
    if (!current || !kind || !currentState || attempts === null || !updatedAt) {
      return null;
    }
    return {
      format_version: QUOTA_API_FORMAT_VERSION,
      id: input.intent.toString(),
      kind,
      state: currentState,
      attempt_count: attempts,
      next_attempt_at: toIsoDateTimeString(current.next_attempt_at),
      processed_at: toIsoDateTimeString(current.processed_at),
      last_error_code:
        typeof current.last_error_code === "string"
          ? current.last_error_code
          : null,
      affected_workspaces: Array.isArray(current.affected_workspaces)
        ? current.affected_workspaces.flatMap((value) => {
            const record = toStringRecordId(value);
            return record ? [record.toString()] : [];
          })
        : [],
      updated_at: updatedAt,
    };
  }
}
