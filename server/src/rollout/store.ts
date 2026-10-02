import { StringRecordId } from "surrealdb";
import type { RolloutGateKey, RolloutGateState, RolloutOperationKind } from "@surreal-ck/shared";
import { getRootDatabaseSession } from "../db/root-connection";
import { toIsoDateTimeString, toStringRecordId, toSurrealNone } from "../db/surreal-values";
import { env } from "../env";
import type {
  RolloutBatchRow,
  RolloutOperationRow,
  RolloutStore,
  RolloutWorkspaceRef,
  WorkspaceGateRow,
} from "./service";

type Queryable = { query(sql: string, params?: Record<string, unknown>): Promise<unknown> };
type SessionFactory = (database: string, namespace: string) => Promise<Queryable>;
type Row = Record<string, unknown>;

const rows = (value: unknown): Row[] => Array.isArray(value) && Array.isArray(value[0]) ? value[0] as Row[] : [];
const first = (value: unknown): Row | null => rows(value)[0] ?? null;
const idOf = (value: unknown): string | null =>
  toStringRecordId(value)?.toString() ?? (typeof value === "string" ? value : null);
const when = (value: unknown): string | null => toIsoDateTimeString(value);
const str = (value: unknown): string | null => typeof value === "string" ? value : null;
const num = (value: unknown): number | null =>
  typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : null;
const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function isConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already|duplicate|unique/iu.test(message);
}

function gateRowOf(row: Row): WorkspaceGateRow | null {
  const id = idOf(row.id);
  const workspaceId = idOf(row.workspace);
  const gate = str(row.gate) as RolloutGateKey | null;
  const state = str(row.state) as RolloutGateState | null;
  const revision = num(row.revision);
  if (!id || !workspaceId || !gate || !state || revision === null) return null;
  return {
    id,
    workspaceId,
    gate,
    state,
    revision,
    reason: str(row.reason) ?? "",
    batchKey: str(row.batch_key),
    updatedBy: str(row.updated_by_subject) ?? "",
    updatedAt: when(row.updated_at) ?? "",
  };
}

function operationRowOf(row: Row): RolloutOperationRow | null {
  const id = idOf(row.id);
  const kind = str(row.kind) as RolloutOperationKind | null;
  if (!id || !kind) return null;
  return {
    id,
    kind,
    gate: (str(row.gate) as RolloutGateKey | null) ?? null,
    workspaceId: idOf(row.workspace),
    workspaceSlug: str(row.workspace_slug),
    batchKey: str(row.batch_key),
    actorSubject: str(row.actor_subject) ?? "",
    capability: str(row.authorized_capability) ?? "",
    reason: str(row.reason) ?? "",
    requestDigest: str(row.request_digest) ?? "",
    idempotencyKey: str(row.idempotency_key) ?? "",
    beforeState: str(row.before_state),
    afterState: str(row.after_state),
    beforeRevision: num(row.before_revision),
    afterRevision: num(row.after_revision),
    correlationId: str(row.correlation_id) ?? "",
    occurredAt: when(row.occurred_at) ?? "",
  };
}

function batchRowOf(row: Row): RolloutBatchRow | null {
  const batchKey = str(row.batch_key);
  const status = str(row.status);
  if (!batchKey || (status !== "draft" && status !== "active" && status !== "closed")) return null;
  const objectsOf = (value: unknown): Row[] =>
    Array.isArray(value) ? value.filter((item): item is Row => !!item && typeof item === "object") : [];
  return {
    batchKey,
    label: str(row.label) ?? "",
    status,
    appRelease: str(row.app_release) ?? "",
    idpRelease: str(row.idp_release) ?? "",
    schemaRevision: str(row.schema_revision) ?? "",
    legalSources: objectsOf(row.legal_sources).flatMap((item) => {
      const sourceKey = str(item.source_key);
      const label = str(item.label);
      const licenseNote = str(item.license_note);
      return sourceKey && label && licenseNote ? [{ sourceKey, label, licenseNote }] : [];
    }),
    planMapping: objectsOf(row.plan_mapping).flatMap((item) => {
      const planKey = str(item.plan_key);
      const displayName = str(item.display_name);
      const aiRate = str(item.ai_rate);
      const legacySubscriptionMap = str(item.legacy_subscription_map);
      return planKey && displayName && aiRate && legacySubscriptionMap
        ? [{ planKey, displayName, aiRate, trialAllowance: num(item.trial_allowance), legacySubscriptionMap }]
        : [];
    }),
    allowedWorkspaces: stringsOf(row.allowed_workspaces),
    gaps: stringsOf(row.gaps),
    reason: str(row.reason) ?? "",
    createdBy: str(row.created_by_subject) ?? "",
    createdAt: when(row.created_at) ?? "",
    activatedBy: str(row.activated_by_subject),
    activatedAt: when(row.activated_at),
    closedBy: str(row.closed_by_subject),
    closedAt: when(row.closed_at),
    closeReason: str(row.close_reason),
    requestDigest: str(row.request_digest) ?? "",
  };
}

/** `_system` 控制面存取：开关状态、操作审计、具名批次。 */
export class SurrealRolloutStore implements RolloutStore {
  constructor(
    private readonly getSession: SessionFactory = getRootDatabaseSession,
    private readonly namespace = env.SURREAL_NS,
  ) {}

  private async db(): Promise<Queryable> {
    return await this.getSession("_system", this.namespace);
  }

  async workspaceBySlug(slug: string): Promise<RolloutWorkspaceRef | null> {
    const row = first(await (await this.db()).query(
      `SELECT id, slug, db_name FROM workspace WHERE slug = $slug LIMIT 1;`,
      { slug },
    ));
    const id = idOf(row?.id);
    const dbName = str(row?.db_name);
    return row && id && typeof row.slug === "string" && dbName
      ? { id, slug: row.slug, dbName }
      : null;
  }

  async gateRow(workspaceId: string, gate: RolloutGateKey): Promise<WorkspaceGateRow | null> {
    const row = first(await (await this.db()).query(
      `SELECT * FROM workspace_rollout_gate WHERE workspace = $workspace AND gate = $gate LIMIT 1;`,
      { workspace: new StringRecordId(workspaceId), gate },
    ));
    return row ? gateRowOf(row) : null;
  }

  async gateRows(workspaceId: string): Promise<WorkspaceGateRow[]> {
    return rows(await (await this.db()).query(
      `SELECT * FROM workspace_rollout_gate WHERE workspace = $workspace;`,
      { workspace: new StringRecordId(workspaceId) },
    )).flatMap((row) => {
      const mapped = gateRowOf(row);
      return mapped ? [mapped] : [];
    });
  }

  async applyGateState(input: {
    workspaceId: string;
    gate: RolloutGateKey;
    expectedRevision: number;
    state: RolloutGateState;
    revision: number;
    reason: string;
    batchKey: string | null;
    actor: string;
  }): Promise<"ok" | "raced"> {
    const db = await this.db();
    if (input.expectedRevision === 0) {
      try {
        await db.query(
          `INSERT INTO workspace_rollout_gate {
            workspace: $workspace, gate: $gate, state: $state, revision: 1,
            reason: $reason, batch_key: $batchKey, updated_by_subject: $actor
          };`,
          {
            workspace: new StringRecordId(input.workspaceId),
            gate: input.gate,
            state: input.state,
            reason: input.reason,
            batchKey: toSurrealNone(input.batchKey),
            actor: input.actor,
          },
        );
        return "ok";
      } catch (error) {
        if (isConflict(error)) return "raced";
        throw error;
      }
    }
    const updated = rows(await db.query(
      `UPDATE workspace_rollout_gate
        SET state = $state, revision = $revision, reason = $reason,
            batch_key = $batchKey, updated_by_subject = $actor
        WHERE workspace = $workspace AND gate = $gate AND revision = $expected
        RETURN id;`,
      {
        workspace: new StringRecordId(input.workspaceId),
        gate: input.gate,
        state: input.state,
        revision: input.revision,
        reason: input.reason,
        batchKey: toSurrealNone(input.batchKey),
        actor: input.actor,
        expected: input.expectedRevision,
      },
    ));
    return updated.length > 0 ? "ok" : "raced";
  }

  async operationByKey(actor: string, idempotencyKey: string): Promise<RolloutOperationRow | null> {
    const row = first(await (await this.db()).query(
      `SELECT * FROM rollout_operation WHERE actor_subject = $actor AND idempotency_key = $key LIMIT 1;`,
      { actor, key: idempotencyKey },
    ));
    return row ? operationRowOf(row) : null;
  }

  async insertOperation(row: Omit<RolloutOperationRow, "id" | "occurredAt">): Promise<"ok" | "conflict"> {
    try {
      await (await this.db()).query(
        `INSERT INTO rollout_operation {
          kind: $kind, gate: $gate, workspace: $workspace, workspace_slug: $workspaceSlug,
          batch_key: $batchKey, actor_subject: $actor, authorized_capability: $capability,
          reason: $reason, request_digest: $digest, idempotency_key: $key,
          before_state: $beforeState, after_state: $afterState,
          before_revision: $beforeRevision, after_revision: $afterRevision,
          correlation_id: $correlationId
        };`,
        {
          kind: row.kind,
          gate: toSurrealNone(row.gate),
          workspace: toSurrealNone(row.workspaceId ? new StringRecordId(row.workspaceId) : null),
          workspaceSlug: toSurrealNone(row.workspaceSlug),
          batchKey: toSurrealNone(row.batchKey),
          actor: row.actorSubject,
          capability: row.capability,
          reason: row.reason,
          digest: row.requestDigest,
          key: row.idempotencyKey,
          beforeState: toSurrealNone(row.beforeState),
          afterState: toSurrealNone(row.afterState),
          beforeRevision: toSurrealNone(row.beforeRevision),
          afterRevision: toSurrealNone(row.afterRevision),
          correlationId: row.correlationId,
        },
      );
      return "ok";
    } catch (error) {
      if (isConflict(error)) return "conflict";
      throw error;
    }
  }

  async operationsForWorkspace(workspaceId: string, limit: number): Promise<RolloutOperationRow[]> {
    return rows(await (await this.db()).query(
      `SELECT * FROM rollout_operation WHERE workspace = $workspace
        ORDER BY occurred_at DESC LIMIT $limit;`,
      { workspace: new StringRecordId(workspaceId), limit },
    )).flatMap((row) => {
      const mapped = operationRowOf(row);
      return mapped ? [mapped] : [];
    });
  }

  async batchByKey(batchKey: string): Promise<RolloutBatchRow | null> {
    const row = first(await (await this.db()).query(
      `SELECT * FROM rollout_batch WHERE batch_key = $key LIMIT 1;`,
      { key: batchKey },
    ));
    return row ? batchRowOf(row) : null;
  }

  async insertBatch(row: Parameters<RolloutStore["insertBatch"]>[0]): Promise<"ok" | "conflict"> {
    try {
      await (await this.db()).query(
        `INSERT INTO rollout_batch {
          batch_key: $batchKey, label: $label, status: "draft",
          app_release: $appRelease, idp_release: $idpRelease, schema_revision: $schemaRevision,
          legal_sources: $legalSources, plan_mapping: $planMapping,
          allowed_workspaces: $allowedWorkspaces, gaps: $gaps,
          reason: $reason, request_digest: $digest, created_by_subject: $createdBy
        };`,
        {
          batchKey: row.batchKey,
          label: row.label,
          appRelease: row.appRelease,
          idpRelease: row.idpRelease,
          schemaRevision: row.schemaRevision,
          legalSources: row.legalSources.map((item) => ({
            source_key: item.sourceKey,
            label: item.label,
            license_note: item.licenseNote,
          })),
          planMapping: row.planMapping.map((item) => ({
            plan_key: item.planKey,
            display_name: item.displayName,
            ai_rate: item.aiRate,
            trial_allowance: toSurrealNone(item.trialAllowance),
            legacy_subscription_map: item.legacySubscriptionMap,
          })),
          allowedWorkspaces: row.allowedWorkspaces,
          gaps: row.gaps,
          reason: row.reason,
          digest: row.requestDigest,
          createdBy: row.createdBy,
        },
      );
      return "ok";
    } catch (error) {
      if (isConflict(error)) return "conflict";
      throw error;
    }
  }

  async transitionBatch(input: {
    batchKey: string;
    expectedStatus: "draft" | "active";
    status: "active" | "closed";
    actor: string;
    reason: string;
  }): Promise<"ok" | "raced" | "missing"> {
    const exists = await this.batchByKey(input.batchKey);
    if (!exists) return "missing";
    const patch = input.status === "active"
      ? `activated_by_subject = $actor, activated_at = time::now()`
      : `closed_by_subject = $actor, closed_at = time::now(), close_reason = $reason`;
    const updated = rows(await (await this.db()).query(
      `UPDATE rollout_batch SET status = $status, ${patch}
        WHERE batch_key = $key AND status = $expected RETURN id;`,
      {
        key: input.batchKey,
        status: input.status,
        expected: input.expectedStatus,
        actor: input.actor,
        reason: input.reason,
      },
    ));
    return updated.length > 0 ? "ok" : "raced";
  }

  async listBatches(limit: number): Promise<RolloutBatchRow[]> {
    return rows(await (await this.db()).query(
      `SELECT * FROM rollout_batch ORDER BY created_at DESC LIMIT $limit;`,
      { limit },
    )).flatMap((row) => {
      const mapped = batchRowOf(row);
      return mapped ? [mapped] : [];
    });
  }

  async activeBatchesForSlug(slug: string): Promise<string[]> {
    return rows(await (await this.db()).query(
      `SELECT VALUE batch_key FROM rollout_batch
        WHERE status = "active" AND allowed_workspaces CONTAINS $slug;`,
      { slug },
    )).flatMap((row) => {
      const value = typeof row === "string" ? row : str(row.batch_key);
      return value ? [value] : [];
    });
  }
}
