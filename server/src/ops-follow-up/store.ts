import type { FollowUpItem, FollowUpReason, FollowUpStatus, SharedActivationSummary } from "@surreal-ck/shared";
import { DateTime, StringRecordId } from "surrealdb";
import { getRootDatabaseSession } from "../db/root-connection";
import { toIsoDateTimeString, toStringRecordId } from "../db/surreal-values";
import { env } from "../env";
import type { FollowUpCursor, OpsFollowUpStore } from "./service";

type Queryable = { query(sql: string, params?: Record<string, unknown>): Promise<unknown> };
type SessionFactory = (database: string, namespace: string) => Promise<Queryable>;
type Row = Record<string, unknown>;

function rows(result: unknown): Row[] {
  return Array.isArray(result) && Array.isArray(result[0]) ? result[0] as Row[] : [];
}

function first(result: unknown): Row | null { return rows(result)[0] ?? null; }
function projection(result: unknown, marker: string): Row | null {
  if (!Array.isArray(result)) return null;
  for (const resultSet of result) {
    if (!Array.isArray(resultSet)) continue;
    const row = resultSet.find((value) => value && typeof value === "object" && marker in value);
    if (row) return row as Row;
  }
  return null;
}
function record(value: unknown): string | null { return toStringRecordId(value)?.toString() ?? null; }
function preciseIso(value: unknown): string | null {
  if (value instanceof DateTime) {
    const match = value.toString().match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/u);
    return match ? `${match[1]}.${(match[2] ?? "").padEnd(9, "0")}Z` : null;
  }
  const iso = toIsoDateTimeString(value);
  return iso ? iso.replace(/\.(\d{3})Z$/u, (_whole, milliseconds: string) => `.${milliseconds}000000Z`) : null;
}

function mapFollowUp(row: Row): FollowUpItem | null {
  const followUpId = record(row.id);
  const workspaceSlug = typeof row.workspace_slug === "string" ? row.workspace_slug : null;
  const reason = typeof row.reason === "string" ? row.reason as FollowUpReason : null;
  const status = typeof row.status === "string" ? row.status as FollowUpStatus : null;
  const startedAt = toIsoDateTimeString(row.period_started_at);
  const endedAt = toIsoDateTimeString(row.period_ended_at);
  const sourceUpdatedAt = preciseIso(row.source_updated_at);
  const summaryId = record(row.source_summary);
  const createdAt = toIsoDateTimeString(row.created_at);
  const updatedAt = preciseIso(row.updated_at);
  if (!followUpId || !workspaceSlug || !summaryId || !reason || !status || !startedAt || !endedAt || !sourceUpdatedAt || !createdAt || !updatedAt || typeof row.dedupe_key !== "string" || typeof row.period_time_zone !== "string" || typeof row.version !== "number") return null;
  return {
    followUpId,
    workspaceSlug,
    summaryId,
    reason,
    period: { startedAt, endedAt, timeZone: row.period_time_zone },
    dedupeKey: row.dedupe_key,
    sourceContractVersion: row.source_contract_version === "2" ? "2" : "1",
    sourceUpdatedAt,
    sourceAvailable: true,
    sourceFreshness: "unknown",
    status,
    ownerSubject: typeof row.owner_subject === "string" ? row.owner_subject : null,
    leaseExpiresAt: toIsoDateTimeString(row.lease_expires_at),
    dueCheckAt: toIsoDateTimeString(row.due_check_at),
    result: typeof row.result === "string" ? row.result : null,
    version: row.version,
    createdAt,
    updatedAt,
    nextStep: status === "resolved" || status === "dismissed" ? "none" : status === "open" ? "claim" : "update",
  };
}

function mapSummary(row: Row): SharedActivationSummary | null {
  const summaryId = record(row.id);
  const status = row.status === "active" || row.status === "withdrawn" ? row.status : null;
  const updatedAt = preciseIso(row.updated_at);
  if (!summaryId || typeof row.workspace_slug !== "string" || !status || !updatedAt) return null;
  return {
    summaryId,
    workspaceSlug: row.workspace_slug,
    contractVersion: row.contract_version === "2" ? "2" : "1",
    status,
    summary: status === "active" && row.content && typeof row.content === "object" ? row.content as SharedActivationSummary["summary"] : null,
    suppliedAt: toIsoDateTimeString(row.supplied_at),
    updatedAt,
    sourceTrust: "team_supplied",
  };
}

export class SurrealOpsFollowUpStore implements OpsFollowUpStore {
  constructor(private readonly getSession: SessionFactory = getRootDatabaseSession, private readonly namespace = env.SURREAL_NS) {}
  private async db() { return await this.getSession("_system", this.namespace); }

  async listActiveSummaries(): Promise<SharedActivationSummary[]> {
    const db = await this.db();
    const summaries: SharedActivationSummary[] = [];
    let cursor: { updatedAt: DateTime; summaryId: StringRecordId } | null = null;
    while (true) {
      const cursorClause = cursor ? `AND (updated_at < $updatedAt OR (updated_at = $updatedAt AND id < $summaryId))` : "";
      const page = rows(await db.query(
        `SELECT * FROM workspace_activation_summary WHERE status = "active" ${cursorClause}
         ORDER BY updated_at DESC, id DESC LIMIT 200;`,
        cursor ? { updatedAt: cursor.updatedAt, summaryId: cursor.summaryId } : {},
      ));
      summaries.push(...page.map(mapSummary).filter((item): item is SharedActivationSummary => item !== null));
      if (page.length < 200) break;
      const tail = page.at(-1)!;
      const updatedAt = preciseIso(tail.updated_at);
      const summaryId = record(tail.id);
      if (!updatedAt || !summaryId) throw new Error("activation summary pagination cursor is invalid");
      cursor = { updatedAt: new DateTime(updatedAt), summaryId: new StringRecordId(summaryId) };
    }
    return summaries;
  }

  async getSummary(summaryId: string): Promise<SharedActivationSummary | null> {
    if (!summaryId.startsWith("workspace_activation_summary:")) return null;
    const row = first(await (await this.db()).query("SELECT * FROM $summary LIMIT 1;", { summary: new StringRecordId(summaryId) }));
    return row ? mapSummary(row) : null;
  }

  async findIdempotent(actorSubject: string, idempotencyKey: string): Promise<{ item: FollowUpItem; requestDigest: string } | null> {
    const row = first(await (await this.db()).query(
      `SELECT follow_up, request_digest FROM activation_follow_up_audit WHERE actor_subject = $actorSubject AND idempotency_key = $idempotencyKey LIMIT 1;`,
      { actorSubject, idempotencyKey },
    ));
    const followUpId = row ? record(row.follow_up) : null;
    const requestDigest = row && typeof row.request_digest === "string" ? row.request_digest : null;
    if (!followUpId || !requestDigest) return null;
    const item = await this.get(followUpId);
    return item ? { item, requestDigest } : null;
  }

  async create(input: Parameters<OpsFollowUpStore["create"]>[0]): Promise<FollowUpItem> {
    const db = await this.db();
    const result = await db.query(
      `BEGIN TRANSACTION;
       LET $source = (SELECT id FROM $sourceSummary WHERE status = "active"
         AND updated_at = $sourceUpdatedAt LIMIT 1);
       IF array::len($source) = 0 { THROW "follow-up source unavailable"; };
       LET $item = (INSERT INTO activation_follow_up {
         workspace_slug: $workspaceSlug, source_summary: $sourceSummary,
         source_contract_version: $sourceContractVersion, source_updated_at: $sourceUpdatedAt,
         reason: $reason, period_started_at: $periodStartedAt, period_ended_at: $periodEndedAt,
         period_time_zone: $periodTimeZone, dedupe_key: $dedupeKey, status: "open",
         owner_subject: NONE, lease_expires_at: NONE, due_check_at: $dueCheckAt,
         result: NONE, version: 1
       } ON DUPLICATE KEY UPDATE dedupe_key = dedupe_key);
       LET $audit = (INSERT INTO activation_follow_up_audit { follow_up: $item[0].id, action: "created", actor_subject: $actorSubject, idempotency_key: $idempotencyKey, request_digest: $requestDigest, version: $item[0].version }
         ON DUPLICATE KEY UPDATE occurred_at = occurred_at);
       IF $audit[0].follow_up != $item[0].id OR $audit[0].request_digest != $requestDigest { THROW "follow-up idempotency conflict"; };
       RETURN $item;
       COMMIT TRANSACTION;`,
      {
        workspaceSlug: input.workspaceSlug,
        sourceSummary: new StringRecordId(input.summaryId),
        sourceContractVersion: input.sourceContractVersion,
        sourceUpdatedAt: new DateTime(input.sourceUpdatedAt),
        reason: input.reason,
        periodStartedAt: new DateTime(input.period.startedAt),
        periodEndedAt: new DateTime(input.period.endedAt),
        periodTimeZone: input.period.timeZone,
        dedupeKey: input.dedupeKey,
        dueCheckAt: input.dueCheckAt ? new DateTime(input.dueCheckAt) : undefined,
        actorSubject: input.actorSubject,
        idempotencyKey: input.idempotencyKey,
        requestDigest: input.requestDigest,
      },
    );
    const item = mapFollowUp(projection(result, "workspace_slug") ?? {});
    if (!item) throw new Error("follow-up create returned no row");
    return item;
  }

  async list(input: { limit: number; cursor: FollowUpCursor | null; workspaceSlugs?: readonly string[] | null }): Promise<FollowUpItem[]> {
    const cursorSql = input.cursor ? `AND (updated_at < $updatedAt OR (updated_at = $updatedAt AND id < $followUpId))` : "";
    const scopeSql = input.workspaceSlugs ? "workspace_slug INSIDE $workspaceSlugs" : "true";
    const params: Record<string, unknown> = { limit: input.limit };
    if (input.workspaceSlugs) params.workspaceSlugs = [...input.workspaceSlugs];
    if (input.cursor) {
      params.updatedAt = new DateTime(input.cursor.updatedAt);
      params.followUpId = new StringRecordId(input.cursor.followUpId);
    }
    return rows(await (await this.db()).query(
      `SELECT * FROM activation_follow_up WHERE ${scopeSql} ${cursorSql} ORDER BY updated_at DESC, id DESC LIMIT $limit;`, params,
    )).map(mapFollowUp).filter((item): item is FollowUpItem => item !== null);
  }

  async get(followUpId: string): Promise<FollowUpItem | null> {
    if (!followUpId.startsWith("activation_follow_up:")) return null;
    const row = first(await (await this.db()).query("SELECT * FROM $followUp LIMIT 1;", { followUp: new StringRecordId(followUpId) }));
    return row ? mapFollowUp(row) : null;
  }

  async claim(input: Parameters<OpsFollowUpStore["claim"]>[0]): Promise<FollowUpItem | null> {
    const db = await this.db();
    const result = await db.query(
      `BEGIN TRANSACTION;
       IF $sourceSummary != NONE {
         LET $source = (SELECT id FROM $sourceSummary WHERE status = "active" AND updated_at = $sourceUpdatedAt LIMIT 1);
         IF array::len($source) = 0 { THROW "follow-up source changed"; };
       };
       LET $changed = (UPDATE $followUp SET owner_subject = $actorSubject, lease_expires_at = $leaseExpiresAt,
         status = "claimed", version += 1, updated_at = time::now()
       WHERE version = $expectedVersion AND status NOTINSIDE ["resolved", "dismissed"]
         AND (owner_subject = $actorSubject OR lease_expires_at = NONE OR lease_expires_at <= $now)
       RETURN AFTER);
       IF array::len($changed) > 0 {
         LET $audit = (INSERT INTO activation_follow_up_audit { follow_up: $changed[0].id, action: "claimed", actor_subject: $actorSubject, idempotency_key: $idempotencyKey, request_digest: $requestDigest, version: $changed[0].version }
           ON DUPLICATE KEY UPDATE occurred_at = occurred_at);
         IF $audit[0].follow_up != $changed[0].id OR $audit[0].request_digest != $requestDigest { THROW "follow-up idempotency conflict"; };
       };
       RETURN $changed;
       COMMIT TRANSACTION;`,
      { followUp: new StringRecordId(input.followUpId), actorSubject: input.actorSubject, leaseExpiresAt: new DateTime(input.leaseExpiresAt), expectedVersion: input.expectedVersion, now: new DateTime(input.now), idempotencyKey: input.idempotencyKey, requestDigest: input.requestDigest, sourceSummary: input.sourceSummaryId ? new StringRecordId(input.sourceSummaryId) : undefined, sourceUpdatedAt: input.sourceUpdatedAt ? new DateTime(input.sourceUpdatedAt) : undefined },
    );
    const row = projection(result, "workspace_slug");
    const item = row ? mapFollowUp(row) : null;
    if (!item) return null;
    return item;
  }

  async update(input: Parameters<OpsFollowUpStore["update"]>[0]): Promise<FollowUpItem | null> {
    const db = await this.db();
    const result = await db.query(
      `BEGIN TRANSACTION;
       IF $sourceSummary != NONE {
         LET $source = (SELECT id FROM $sourceSummary WHERE status = "active" AND updated_at = $sourceUpdatedAt LIMIT 1);
         IF array::len($source) = 0 { THROW "follow-up source changed"; };
       };
       LET $changed = (UPDATE $followUp SET status = $status, due_check_at = $dueCheckAt, result = $result, version += 1, updated_at = time::now()
       WHERE version = $expectedVersion AND owner_subject = $actorSubject AND lease_expires_at > $now
         AND status NOTINSIDE ["resolved", "dismissed"] RETURN AFTER);
       IF array::len($changed) > 0 {
         LET $audit = (INSERT INTO activation_follow_up_audit { follow_up: $changed[0].id, action: "updated", actor_subject: $actorSubject, idempotency_key: $idempotencyKey, request_digest: $requestDigest, version: $changed[0].version }
           ON DUPLICATE KEY UPDATE occurred_at = occurred_at);
         IF $audit[0].follow_up != $changed[0].id OR $audit[0].request_digest != $requestDigest { THROW "follow-up idempotency conflict"; };
       };
       RETURN $changed;
       COMMIT TRANSACTION;`,
      {
        followUp: new StringRecordId(input.followUpId), status: input.status,
        dueCheckAt: input.dueCheckAt ? new DateTime(input.dueCheckAt) : undefined,
        result: input.result ?? undefined, expectedVersion: input.expectedVersion,
        actorSubject: input.actorSubject, now: new DateTime(input.now),
        idempotencyKey: input.idempotencyKey,
        requestDigest: input.requestDigest,
        sourceSummary: input.sourceSummaryId ? new StringRecordId(input.sourceSummaryId) : undefined,
        sourceUpdatedAt: input.sourceUpdatedAt ? new DateTime(input.sourceUpdatedAt) : undefined,
      },
    );
    const row = projection(result, "workspace_slug");
    const item = row ? mapFollowUp(row) : null;
    if (!item) return null;
    return item;
  }
}
