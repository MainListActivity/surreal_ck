import { createHash } from "node:crypto";
import type { OpsAutonomyAction, OpsAutonomyAudit, OpsAutonomyPolicy } from "@surreal-ck/shared";
import { StringRecordId } from "surrealdb";
import { getRootDatabaseSession } from "../db/root-connection";
import { toIsoDateTimeString, toStringRecordId } from "../db/surreal-values";
import { env } from "../env";
import type { OpsAutonomyStore } from "./service";

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
function mapPolicy(row: Row): OpsAutonomyPolicy | null {
  const policyId = record(row.id);
  const updatedAt = toIsoDateTimeString(row.updated_at);
  if (!policyId || typeof row.agent_subject !== "string" || typeof row.workspace_slug !== "string" || !Array.isArray(row.actions)
    || typeof row.status !== "string" || typeof row.version !== "number" || typeof row.updated_by_subject !== "string" || !updatedAt) return null;
  return { policyId, agentSubject: row.agent_subject, workspaceSlug: row.workspace_slug,
    actions: row.actions.filter((value): value is OpsAutonomyAction => typeof value === "string"),
    status: row.status as OpsAutonomyPolicy["status"], version: row.version,
    updatedBySubject: row.updated_by_subject, updatedAt };
}
function mapAudit(row: Row): OpsAutonomyAudit | null {
  const auditId = record(row.id);
  const policyId = record(row.policy);
  const occurredAt = toIsoDateTimeString(row.occurred_at);
  if (!auditId || !policyId || !occurredAt || typeof row.event !== "string" || typeof row.actor_subject !== "string" || typeof row.reason !== "string" || typeof row.version !== "number") return null;
  return { auditId, policyId, event: row.event as OpsAutonomyAudit["event"], actorSubject: row.actor_subject,
    reason: row.reason, version: row.version, occurredAt };
}
const auditInsert = `LET $audit = (INSERT INTO ops_agent_policy_audit { policy: $changed[0].id, event: $event,
  actor_subject: $actorSubject, reason: $reason, version: $changed[0].version,
  request_digest: $requestDigest, idempotency_key_hash: $idempotencyKeyHash }
  ON DUPLICATE KEY UPDATE occurred_at = occurred_at);
IF $audit[0].policy != $changed[0].id OR $audit[0].request_digest != $requestDigest { THROW "autonomy idempotency conflict"; };`;

export class SurrealOpsAutonomyStore implements OpsAutonomyStore {
  constructor(private readonly getSession: SessionFactory = getRootDatabaseSession, private readonly namespace = env.SURREAL_NS) {}
  private async db() { return await this.getSession("_system", this.namespace); }
  async getOperatorKind(subject: string): Promise<"human" | "agent" | null> {
    const row = first(await (await this.db()).query(`SELECT kind FROM platform_operator WHERE subject = $subject AND status = "active" LIMIT 1;`, { subject }));
    return row?.kind === "human" || row?.kind === "agent" ? row.kind : null;
  }
  async getOperatorCapabilities(subject: string): Promise<readonly string[]> {
    const result = await (await this.db()).query(`SELECT VALUE capability FROM platform_operator_capability
      WHERE status = "active" AND operator IN (SELECT VALUE id FROM platform_operator WHERE subject = $subject AND status = "active");`, { subject });
    return Array.isArray(result) && Array.isArray(result[0]) ? result[0].filter((value): value is string => typeof value === "string") : [];
  }
  async workspaceExists(workspaceSlug: string): Promise<boolean> {
    return first(await (await this.db()).query(`SELECT id FROM workspace WHERE slug = $workspaceSlug AND status = "active" LIMIT 1;`, { workspaceSlug })) !== null;
  }
  async listPolicies(agentSubject?: string): Promise<OpsAutonomyPolicy[]> {
    const where = agentSubject ? "WHERE agent_subject = $agentSubject" : "";
    return rows(await (await this.db()).query(`SELECT * FROM ops_agent_policy ${where} ORDER BY agent_subject, workspace_slug;`, { agentSubject })).map(mapPolicy).filter((value): value is OpsAutonomyPolicy => value !== null);
  }
  async listAudit(policyId?: string): Promise<OpsAutonomyAudit[]> {
    const where = policyId ? "WHERE policy = $policy" : "";
    const params = policyId ? { policy: new StringRecordId(policyId) } : {};
    return rows(await (await this.db()).query(`SELECT * FROM ops_agent_policy_audit ${where} ORDER BY occurred_at DESC LIMIT 200;`, params)).map(mapAudit).filter((value): value is OpsAutonomyAudit => value !== null);
  }
  async getPolicy(agentSubject: string, workspaceSlug: string): Promise<OpsAutonomyPolicy | null> {
    const row = first(await (await this.db()).query(`SELECT * FROM ops_agent_policy WHERE agent_subject = $agentSubject AND workspace_slug = $workspaceSlug LIMIT 1;`, { agentSubject, workspaceSlug }));
    return row ? mapPolicy(row) : null;
  }
  async getById(policyId: string): Promise<OpsAutonomyPolicy | null> {
    if (!policyId.startsWith("ops_agent_policy:")) return null;
    const row = first(await (await this.db()).query("SELECT * FROM $policy LIMIT 1;", { policy: new StringRecordId(policyId) }));
    return row ? mapPolicy(row) : null;
  }
  async findIdempotent(actorSubject: string, idempotencyKey: string): Promise<{ policy: OpsAutonomyPolicy; requestDigest: string } | null> {
    const row = first(await (await this.db()).query(`SELECT policy, request_digest FROM ops_agent_policy_audit
      WHERE actor_subject = $actorSubject AND idempotency_key_hash = $keyHash LIMIT 1;`, { actorSubject, keyHash: keyDigest(idempotencyKey) }));
    const policyId = row ? record(row.policy) : null;
    const requestDigest = row && typeof row.request_digest === "string" ? row.request_digest : null;
    if (!policyId || !requestDigest) return null;
    const policy = await this.getById(policyId);
    return policy ? { policy, requestDigest } : null;
  }
  async save(input: Parameters<OpsAutonomyStore["save"]>[0]): Promise<OpsAutonomyPolicy | null> {
    const db = await this.db();
    const common = { agentSubject: input.agentSubject, workspaceSlug: input.workspaceSlug, actions: input.actions,
      status: input.status, actorSubject: input.actorSubject, event: input.event, reason: input.reason,
      requestDigest: input.requestDigest, idempotencyKeyHash: keyDigest(input.idempotencyKey) };
    if (input.expectedVersion === null) {
      const result = await db.query(`BEGIN TRANSACTION;
        LET $changed = (INSERT INTO ops_agent_policy { agent_subject: $agentSubject, workspace_slug: $workspaceSlug,
          actions: $actions, status: $status, version: 1, updated_by_subject: $actorSubject,
          last_request_digest: $requestDigest }
          ON DUPLICATE KEY UPDATE agent_subject = agent_subject);
        IF $changed[0].last_request_digest != $requestDigest { THROW "autonomy policy already exists"; };
        ${auditInsert}
        RETURN $changed;
        COMMIT TRANSACTION;`, common);
      const row = projection(result, "agent_subject");
      return row ? mapPolicy(row) : null;
    }
    const current = await this.getPolicy(input.agentSubject, input.workspaceSlug);
    if (!current) return null;
    const result = await db.query(`BEGIN TRANSACTION;
      LET $changed = (UPDATE $policy SET actions = $actions, status = $status, version += 1,
        updated_by_subject = $actorSubject, last_request_digest = $requestDigest, updated_at = time::now()
        WHERE version = $expectedVersion RETURN AFTER);
      IF array::len($changed) > 0 { ${auditInsert} };
      RETURN $changed;
      COMMIT TRANSACTION;`, { ...common, policy: new StringRecordId(current.policyId), expectedVersion: input.expectedVersion });
    const row = projection(result, "agent_subject");
    return row ? mapPolicy(row) : null;
  }
}
