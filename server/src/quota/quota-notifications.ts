import type {
  QuotaInAppNotification,
} from "@surreal-ck/shared/native-quota";
import { DateTime, StringRecordId } from "surrealdb";
import { getRootDatabaseSession } from "../db/root-connection";
import {
  toIsoDateTimeString,
  toStringRecordId,
} from "../db/surreal-values";

type Queryable = {
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

export interface QuotaNotificationService {
  list(input: Readonly<{
    actorSubject: string;
    limit: number;
  }>): Promise<readonly QuotaInAppNotification[]>;
  markRead(input: Readonly<{
    notification: StringRecordId;
    actorSubject: string;
  }>): Promise<boolean>;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rows(result: unknown): UnknownRecord[] {
  if (!Array.isArray(result)) return [];
  const statement = result[0];
  return Array.isArray(statement) ? statement.filter(isRecord) : [];
}

function apiCount(value: unknown): number | string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  return null;
}

function notification(
  row: UnknownRecord,
  readAtByNotification: ReadonlyMap<string, string>,
): QuotaInAppNotification | null {
  const id = toStringRecordId(row.id);
  const workspace = isRecord(row.workspace) ? row.workspace : null;
  const payload = isRecord(row.payload) ? row.payload : null;
  const workspaceId = toStringRecordId(workspace?.id);
  const createdAt = toIsoDateTimeString(row.created_at);
  const used = apiCount(payload?.used);
  const limit = apiCount(payload?.limit);
  const threshold = payload?.threshold_percent;
  const kind =
    payload?.kind === "over_limit"
      ? "over_limit"
      : payload?.kind === "threshold"
        ? "threshold"
        : null;
  if (
    !id
    || !workspace
    || !workspaceId
    || typeof workspace.slug !== "string"
    || typeof workspace.name !== "string"
    || !payload
    || !kind
    || (threshold !== 80 && threshold !== 90 && threshold !== 100)
    || typeof payload.resource_key !== "string"
    || typeof payload.label !== "string"
    || used === null
    || limit === null
    || !createdAt
  ) {
    return null;
  }
  return {
    id: id.toString(),
    workspace: {
      id: workspaceId.toString(),
      slug: workspace.slug,
      name: workspace.name,
    },
    kind,
    threshold_percent: threshold,
    resource_key: payload.resource_key,
    label: payload.label,
    table:
      typeof payload.table_identity === "string"
        ? payload.table_identity
        : null,
    used,
    limit,
    created_at: createdAt,
    read_at: readAtByNotification.get(id.toString()) ?? null,
  };
}

export class SurrealQuotaNotificationService
implements QuotaNotificationService {
  private readonly getDb: () => Promise<Queryable>;

  constructor(options: Readonly<{
    db?: Queryable;
    getDb?: () => Promise<Queryable>;
  }> = {}) {
    this.getDb = options.db
      ? async () => options.db!
      : options.getDb ?? (() => getRootDatabaseSession("_system"));
  }

  async list(input: Readonly<{
    actorSubject: string;
    limit: number;
  }>): Promise<readonly QuotaInAppNotification[]> {
    const db = await this.getDb();
    const outboxResult = await db.query(
      `
        SELECT id, workspace, payload, created_at
        FROM quota_notification_outbox
        WHERE recipient_subject = $subject
        ORDER BY created_at DESC
        LIMIT $limit
        FETCH workspace;
      `,
      {
        subject: input.actorSubject,
        limit: input.limit,
      },
    );
    const outbox = rows(outboxResult);
    const ids = outbox.flatMap((row) => {
      const id = toStringRecordId(row.id);
      return id ? [id] : [];
    });
    const deliveryResult = ids.length === 0
      ? []
      : await db.query(
          `
            SELECT notification, read_at
            FROM quota_notification_delivery
            WHERE notification IN $notifications;
          `,
          { notifications: ids },
        );
    const readAtByNotification = new Map<string, string>();
    for (const row of rows(deliveryResult)) {
      const id = toStringRecordId(row.notification);
      const readAt = toIsoDateTimeString(row.read_at);
      if (id && readAt) readAtByNotification.set(id.toString(), readAt);
    }
    return outbox.flatMap((row) => {
      const parsed = notification(row, readAtByNotification);
      return parsed ? [parsed] : [];
    });
  }

  async markRead(input: Readonly<{
    notification: StringRecordId;
    actorSubject: string;
  }>): Promise<boolean> {
    const db = await this.getDb();
    const result = await db.query(
      `
        LET $owned = (
          SELECT VALUE id
          FROM ONLY $notification
          WHERE recipient_subject = $subject
        );
        IF $owned != NONE {
          UPDATE quota_notification_delivery
          SET read_at = $read_at
          WHERE notification = $notification;
        };
        RETURN $owned != NONE;
      `,
      {
        notification: input.notification,
        subject: input.actorSubject,
        read_at: DateTime.now(),
      },
    );
    if (!Array.isArray(result)) return false;
    return result.some((statement) =>
      statement === true
      || (Array.isArray(statement) && statement.includes(true))
    );
  }
}
