import { createHash } from "node:crypto";
import type { FollowUpItem, OpsProposal, OpsProposalAction } from "@surreal-ck/shared";
import { DateTime, StringRecordId } from "surrealdb";
import { getRootDatabaseSession } from "../db/root-connection";
import { toIsoDateTimeString, toStringRecordId } from "../db/surreal-values";
import { env } from "../env";
import { SurrealOpsFollowUpStore } from "../ops-follow-up/store";
import { digestProposalAction, type OpsProposalCursor, type OpsProposalStore } from "./service";

type Queryable = { query(sql: string, params?: Record<string, unknown>): Promise<unknown> };
type SessionFactory = (database: string, namespace: string) => Promise<Queryable>;
type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => Array.isArray(value) && Array.isArray(value[0]) ? value[0] as Row[] : [];
const first = (value: unknown): Row | null => rows(value)[0] ?? null;
function projection(value: unknown, marker: string): Row | null {
  if (!Array.isArray(value)) return null;
  for (const group of value) {
    if (!Array.isArray(group)) continue;
    const found = group.find((row) => row && typeof row === "object" && marker in row);
    if (found) return found as Row;
  }
  return null;
}
const record = (value: unknown) => toStringRecordId(value)?.toString() ?? null;
const keyDigest = (value: string) => createHash("sha256").update(value).digest("hex");
function preciseIso(value: unknown): string | null {
  if (value instanceof DateTime) {
    const match = value.toString().match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/u);
    return match ? `${match[1]}.${(match[2] ?? "").padEnd(9, "0")}Z` : null;
  }
  return toIsoDateTimeString(value);
}
function mapProposal(row: Row): OpsProposal | null {
  const proposalId = record(row.id);
  const followUpId = record(row.follow_up);
  const summaryId = record(row.source_summary);
  const summaryUpdatedAt = preciseIso(row.source_updated_at);
  const createdAt = toIsoDateTimeString(row.created_at);
  const updatedAt = preciseIso(row.updated_at);
  if (!proposalId || !followUpId || !summaryId || !summaryUpdatedAt || !createdAt || !updatedAt || typeof row.version !== "number" || typeof row.follow_up_version !== "number" || typeof row.status !== "string" || typeof row.proposer_subject !== "string" || typeof row.rationale !== "string" || typeof row.expected_result !== "string" || typeof row.trigger_reason !== "string" || typeof row.input_summary !== "string" || !row.action || typeof row.action !== "object") return null;
  return {
    proposalId, followUpId, summaryId, summaryUpdatedAt, followUpVersion: row.follow_up_version,
    action: row.action as OpsProposalAction, actionDigest: String(row.action_digest ?? ""), rationale: row.rationale, expectedResult: row.expected_result,
    triggerReason: row.trigger_reason, inputSummary: row.input_summary, proposerSubject: row.proposer_subject,
    agentId: typeof row.agent_id === "string" ? row.agent_id : null,
    status: row.status as OpsProposal["status"], version: row.version,
    executorSubject: typeof row.executor_subject === "string" ? row.executor_subject : null,
    reviewerSubject: typeof row.reviewer_subject === "string" ? row.reviewer_subject : null,
    reviewReason: typeof row.review_reason === "string" ? row.review_reason : null,
    toolResult: row.tool_result && typeof row.tool_result === "object" ? row.tool_result as OpsProposal["toolResult"] : null,
    actionFollowUpVersion: typeof row.action_follow_up_version === "number" ? row.action_follow_up_version : null,
    createdAt, updatedAt,
  };
}

export class SurrealOpsProposalStore implements OpsProposalStore {
  private readonly followUps: SurrealOpsFollowUpStore;
  constructor(private readonly getSession: SessionFactory = getRootDatabaseSession, private readonly namespace = env.SURREAL_NS) {
    this.followUps = new SurrealOpsFollowUpStore(getSession, namespace);
  }
  private async db() { return await this.getSession("_system", this.namespace); }
  async getFollowUp(followUpId: string): Promise<FollowUpItem | null> {
    const item = await this.followUps.get(followUpId);
    if (!item) return null;
    const summaryUpdatedAt = await this.getSummaryUpdatedAt(item.summaryId);
    const sourceAvailable = summaryUpdatedAt === item.sourceUpdatedAt;
    const age = summaryUpdatedAt ? Date.now() - Date.parse(summaryUpdatedAt) : Number.NaN;
    return { ...item, sourceAvailable, sourceFreshness: !sourceAvailable ? "unavailable" : !Number.isFinite(age) || age < 0 ? "unknown" : age > 30 * 86400_000 ? "stale" : "fresh" };
  }
  async getSummaryUpdatedAt(summaryId: string): Promise<string | null> {
    if (!summaryId.startsWith("workspace_activation_summary:")) return null;
    const row = first(await (await this.db()).query("SELECT updated_at FROM $summary WHERE status = 'active' LIMIT 1;", { summary: new StringRecordId(summaryId) }));
    return row ? preciseIso(row.updated_at) : null;
  }
  async findByIdempotency(actorSubject: string, idempotencyKey: string): Promise<{ item: OpsProposal; requestDigest: string } | null> {
    const row = first(await (await this.db()).query("SELECT proposal, request_digest FROM ops_proposal_audit WHERE actor_subject = $actorSubject AND idempotency_key = $idempotencyKey LIMIT 1;", { actorSubject, idempotencyKey: keyDigest(idempotencyKey) }));
    const id = row ? record(row.proposal) : null;
    const requestDigest = row && typeof row.request_digest === "string" ? row.request_digest : null;
    if (!id || !requestDigest) return null;
    const item = await this.get(id);
    return item ? { item, requestDigest } : null;
  }
  async get(proposalId: string): Promise<OpsProposal | null> {
    if (!proposalId.startsWith("ops_proposal:")) return null;
    const row = first(await (await this.db()).query("SELECT * FROM $proposal LIMIT 1;", { proposal: new StringRecordId(proposalId) }));
    return row ? mapProposal(row) : null;
  }
  async list(input: { limit: number; cursor: OpsProposalCursor | null }): Promise<OpsProposal[]> {
    const clause = input.cursor ? "WHERE updated_at < $updatedAt OR (updated_at = $updatedAt AND id < $proposalId)" : "";
    const params: Record<string, unknown> = { limit: input.limit };
    if (input.cursor) { params.updatedAt = new DateTime(input.cursor.updatedAt); params.proposalId = new StringRecordId(input.cursor.proposalId); }
    return rows(await (await this.db()).query(`SELECT * FROM ops_proposal ${clause} ORDER BY updated_at DESC, id DESC LIMIT $limit;`, params)).map(mapProposal).filter((row): row is OpsProposal => row !== null);
  }
  async create(input: Parameters<OpsProposalStore["create"]>[0]): Promise<OpsProposal> {
    const actionDigest = digestProposalAction(input.action);
    const result = await (await this.db()).query(`BEGIN TRANSACTION;
      LET $source = (SELECT id FROM $summary WHERE status = "active" AND updated_at = $sourceUpdatedAt LIMIT 1);
      LET $current = (SELECT id FROM $followUp WHERE version = $followUpVersion AND source_updated_at = $sourceUpdatedAt AND status NOTINSIDE ["resolved", "dismissed"] LIMIT 1);
      IF array::len($source) = 0 OR array::len($current) = 0 { THROW "proposal premise changed"; };
      LET $created = (INSERT INTO ops_proposal { follow_up: $followUp, source_summary: $summary, source_updated_at: $sourceUpdatedAt,
        follow_up_version: $followUpVersion, action: $action, action_digest: $actionDigest, rationale: $rationale,
        expected_result: $expectedResult, trigger_reason: $triggerReason, input_summary: $inputSummary,
        proposer_subject: $actorSubject, agent_id: $agentId, status: "pending", version: 1,
        reviewer_subject: NONE, review_reason: NONE, executor_subject: NONE, tool_result: NONE, action_follow_up_version: NONE });
      LET $audit = (INSERT INTO ops_proposal_audit { proposal: $created[0].id, event: "submitted", actor_subject: $actorSubject,
        agent_id: $agentId, trigger_reason: $triggerReason, input_summary: $inputSummary,
        idempotency_key: $idempotencyKey, request_digest: $requestDigest, status: "pending", tool_result: NONE, version: 1 }
        ON DUPLICATE KEY UPDATE occurred_at = occurred_at);
      IF $audit[0].proposal != $created[0].id OR $audit[0].request_digest != $requestDigest { THROW "proposal idempotency conflict"; };
      RETURN $created;
      COMMIT TRANSACTION;`, {
      followUp: new StringRecordId(input.followUpId), summary: new StringRecordId(input.summaryId), sourceUpdatedAt: new DateTime(input.summaryUpdatedAt),
      followUpVersion: input.followUpVersion, action: input.action, actionDigest, rationale: input.rationale,
      expectedResult: input.expectedResult, triggerReason: input.triggerReason, inputSummary: input.inputSummary,
      actorSubject: input.actorSubject, agentId: input.agentId ?? undefined, idempotencyKey: keyDigest(input.idempotencyKey), requestDigest: input.requestDigest,
    });
    const item = mapProposal(projection(result, "follow_up") ?? {});
    if (!item) throw new Error("proposal create returned no row");
    return item;
  }
  async review(input: Parameters<OpsProposalStore["review"]>[0]): Promise<OpsProposal | null> {
    const status = input.decision === "approve" ? "approved" : "rejected";
    const result = await (await this.db()).query(`BEGIN TRANSACTION;
      LET $candidate = (SELECT * FROM $proposal WHERE version = $expectedVersion AND status = "pending" AND action_digest = $actionDigest LIMIT 1);
      IF $status = "approved" AND array::len($candidate) > 0 {
        LET $source = (SELECT id FROM $candidate[0].source_summary WHERE status = "active" AND updated_at = $candidate[0].source_updated_at LIMIT 1);
        LET $followUpCurrent = (SELECT id FROM $candidate[0].follow_up WHERE version = $candidate[0].follow_up_version AND source_updated_at = $candidate[0].source_updated_at AND status NOTINSIDE ["resolved", "dismissed"] LIMIT 1);
        IF array::len($source) = 0 OR array::len($followUpCurrent) = 0 { THROW "proposal premise changed"; };
      };
      LET $changed = (UPDATE $proposal SET status = $status, reviewer_subject = $actorSubject, review_reason = $reason,
        version += 1, updated_at = time::now()
        WHERE version = $expectedVersion AND status = "pending" AND action_digest = $actionDigest
        RETURN AFTER);
      IF array::len($changed) > 0 {
        LET $audit = (INSERT INTO ops_proposal_audit { proposal: $changed[0].id, event: $status, actor_subject: $actorSubject,
          agent_id: $agentId, trigger_reason: $changed[0].trigger_reason, input_summary: $changed[0].input_summary,
          idempotency_key: $idempotencyKey, request_digest: $requestDigest, status: $status, tool_result: NONE,
          version: $changed[0].version } ON DUPLICATE KEY UPDATE occurred_at = occurred_at);
        IF $audit[0].proposal != $changed[0].id OR $audit[0].request_digest != $requestDigest { THROW "proposal idempotency conflict"; };
      };
      RETURN $changed;
      COMMIT TRANSACTION;`, { proposal: new StringRecordId(input.proposalId), status, actorSubject: input.actorSubject, reason: input.reason,
      expectedVersion: input.expectedVersion, actionDigest: input.actionDigest, agentId: input.agentId ?? undefined,
      idempotencyKey: keyDigest(input.idempotencyKey), requestDigest: input.requestDigest });
    const row = projection(result, "follow_up");
    return row ? mapProposal(row) : null;
  }
  async reserve(input: Parameters<OpsProposalStore["reserve"]>[0]): Promise<OpsProposal | null> {
    const result = await (await this.db()).query(`BEGIN TRANSACTION;
      LET $changed = (UPDATE $proposal SET status = "executing", executor_subject = $actorSubject,
        version += 1, updated_at = time::now()
        WHERE version = $expectedVersion AND status = "approved" RETURN AFTER);
      IF array::len($changed) > 0 {
        LET $audit = (INSERT INTO ops_proposal_audit { proposal: $changed[0].id, event: "execution_started", actor_subject: $actorSubject,
          agent_id: $agentId, trigger_reason: $changed[0].trigger_reason, input_summary: $changed[0].input_summary,
          idempotency_key: $idempotencyKey, request_digest: $requestDigest, status: "executing", tool_result: NONE,
          version: $changed[0].version } ON DUPLICATE KEY UPDATE occurred_at = occurred_at);
        IF $audit[0].proposal != $changed[0].id OR $audit[0].request_digest != $requestDigest { THROW "proposal idempotency conflict"; };
      };
      RETURN $changed;
      COMMIT TRANSACTION;`, { proposal: new StringRecordId(input.proposalId), expectedVersion: input.expectedVersion,
      actorSubject: input.actorSubject, agentId: input.agentId ?? undefined, idempotencyKey: keyDigest(input.idempotencyKey), requestDigest: input.requestDigest });
    const row = projection(result, "follow_up");
    return row ? mapProposal(row) : null;
  }
  async finish(input: Parameters<OpsProposalStore["finish"]>[0]): Promise<OpsProposal | null> {
    const result = await (await this.db()).query(`BEGIN TRANSACTION;
      LET $changed = (UPDATE $proposal SET status = $status, tool_result = $toolResult,
        action_follow_up_version = $actionFollowUpVersion, version += 1, updated_at = time::now()
        WHERE version = $expectedVersion AND (status = "approved" OR (status = "executing" AND executor_subject = $actorSubject)) RETURN AFTER);
      IF array::len($changed) > 0 {
        LET $audit = (INSERT INTO ops_proposal_audit { proposal: $changed[0].id, event: $status, actor_subject: $actorSubject,
          agent_id: $agentId, trigger_reason: $changed[0].trigger_reason, input_summary: $changed[0].input_summary,
          idempotency_key: $idempotencyKey, request_digest: $requestDigest, status: $status, tool_result: $toolResult,
          version: $changed[0].version } ON DUPLICATE KEY UPDATE occurred_at = occurred_at);
        IF $audit[0].proposal != $changed[0].id OR $audit[0].request_digest != $requestDigest { THROW "proposal idempotency conflict"; };
      };
      RETURN $changed;
      COMMIT TRANSACTION;`, { proposal: new StringRecordId(input.proposalId), status: input.status, toolResult: input.toolResult,
      actionFollowUpVersion: input.actionFollowUpVersion ?? undefined, expectedVersion: input.expectedVersion,
      actorSubject: input.actorSubject, agentId: input.agentId ?? undefined, idempotencyKey: keyDigest(input.idempotencyKey), requestDigest: input.requestDigest });
    const row = projection(result, "follow_up");
    return row ? mapProposal(row) : null;
  }
  async takeover(input: Parameters<OpsProposalStore["takeover"]>[0]): Promise<FollowUpItem | null> {
    const result = await (await this.db()).query(`BEGIN TRANSACTION;
      LET $changed = (UPDATE $followUp SET owner_subject = $actorSubject, lease_expires_at = $leaseExpiresAt,
        status = "claimed", version += 1, updated_at = time::now()
        WHERE version = $expectedVersion AND status NOTINSIDE ["resolved", "dismissed"] RETURN AFTER);
      IF array::len($changed) > 0 {
        LET $audit = (INSERT INTO activation_follow_up_audit { follow_up: $changed[0].id, action: "taken_over",
          actor_subject: $actorSubject, reason: $reason, idempotency_key: $idempotencyKey,
          request_digest: $requestDigest, version: $changed[0].version }
          ON DUPLICATE KEY UPDATE occurred_at = occurred_at);
        IF $audit[0].follow_up != $changed[0].id OR $audit[0].request_digest != $requestDigest { THROW "takeover idempotency conflict"; };
      };
      RETURN $changed;
      COMMIT TRANSACTION;`, { followUp: new StringRecordId(input.followUpId), actorSubject: input.actorSubject,
      leaseExpiresAt: new DateTime(input.leaseExpiresAt), expectedVersion: input.expectedVersion, reason: input.reason,
      idempotencyKey: keyDigest(input.idempotencyKey), requestDigest: input.requestDigest });
    const row = projection(result, "workspace_slug");
    if (!row) return null;
    return await this.followUps.get(record(row.id) ?? "");
  }
  async findTakeoverIdempotency(actorSubject: string, idempotencyKey: string): Promise<{ item: FollowUpItem; requestDigest: string } | null> {
    return await this.followUps.findIdempotent(actorSubject, keyDigest(idempotencyKey));
  }
  async findAppliedAction(actorSubject: string, idempotencyKey: string, followUpId: string): Promise<{ followUpVersion: number } | null> {
    if (!followUpId.startsWith("activation_follow_up:")) return null;
    const row = first(await (await this.db()).query(`SELECT follow_up, version FROM activation_follow_up_audit
      WHERE actor_subject = $actorSubject AND idempotency_key = $idempotencyKey LIMIT 1;`, { actorSubject, idempotencyKey }));
    if (!row || record(row.follow_up) !== followUpId || typeof row.version !== "number") return null;
    return { followUpVersion: row.version };
  }
}
