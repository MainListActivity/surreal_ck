import { omitNullishSurrealFields } from "@surreal-ck/shared";
import type {
  PlatformOperatorCapability,
  ProductQuotaRule,
  QuotaOverridePatch,
  QuotaSubscriptionSource,
  QuotaSubscriptionStatus,
  SurrealInteger,
} from "@surreal-ck/shared/native-quota";
import { DateTime, StringRecordId } from "surrealdb";
import { toStringRecordId } from "../db/surreal-values";
import { stableSha256 } from "./canonical";
import {
  resolveResourceEntitlement,
  type EntitlementBaseCandidate,
  type EntitlementOverrideRevision,
  type EntitlementPlanRevision,
} from "./entitlement-resolver";
import { compileQuotaPolicy } from "./policy-compiler";
import type {
  EntitlementRefreshPort,
  EntitlementRefreshResult,
} from "./subscription-lifecycle";
import { QuotaLifecycleError } from "./subscription-lifecycle";

export type EntitlementRefreshQueryClient = Readonly<{
  query<T = unknown>(
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
}>;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statementRows(result: unknown, index: number): UnknownRecord[] {
  if (!Array.isArray(result)) return [];
  const statement = result[index];
  if (Array.isArray(statement)) return statement.filter(isRecord);
  return isRecord(statement) ? [statement] : [];
}

function firstRow(result: unknown, index = 0): UnknownRecord | undefined {
  return statementRows(result, index)[0];
}

function requiredId(value: unknown, field: string): StringRecordId {
  const id = toStringRecordId(value);
  if (!id) {
    throw new QuotaLifecycleError(
      "entitlement_context_invalid",
      `invalid ${field} record id`,
    );
  }
  return id;
}

function optionalId(value: unknown): StringRecordId | undefined {
  return toStringRecordId(value) ?? undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new QuotaLifecycleError(
      "entitlement_context_invalid",
      `invalid ${field}`,
    );
  }
  return value;
}

function dateTime(value: unknown, field: string): DateTime {
  if (value instanceof DateTime) return value;
  if (value instanceof Date) return new DateTime(value.toISOString());
  if (typeof value === "string") return new DateTime(value);
  throw new QuotaLifecycleError(
    "entitlement_context_invalid",
    `invalid ${field} datetime`,
  );
}

function optionalDateTime(value: unknown): DateTime | undefined {
  if (value === undefined || value === null) return undefined;
  return dateTime(value, "optional");
}

function integer(value: unknown, fallback = 0): SurrealInteger {
  if (
    typeof value === "bigint"
    || (typeof value === "number" && Number.isSafeInteger(value))
  ) {
    return value;
  }
  return fallback;
}

function deterministicId(
  table: string,
  ...identity: readonly string[]
): StringRecordId {
  return new StringRecordId(
    `${table}:q_${stableSha256(identity.join("\0")).slice(0, 28)}`,
  );
}

function planRevisionFromRow(row: UnknownRecord): EntitlementPlanRevision {
  const templateKind = requiredString(row.template_kind, "plan template");
  if (
    templateKind !== "commercial"
    && templateKind !== "trial"
    && templateKind !== "contract"
    && templateKind !== "retention"
  ) {
    throw new QuotaLifecycleError(
      "entitlement_context_invalid",
      `unknown plan template kind: ${templateKind}`,
    );
  }
  return Object.freeze({
    id: requiredId(row.id, "plan revision"),
    template_kind: templateKind,
    rules: Array.isArray(row.rules)
      ? row.rules as readonly ProductQuotaRule[]
      : [],
  });
}

function subscriptionFromRow(
  row: UnknownRecord,
): EntitlementBaseCandidate["subscription"] {
  const source = requiredString(row.source, "subscription source");
  const status = requiredString(row.status, "subscription status");
  return Object.freeze({
    id: requiredId(row.id, "subscription"),
    billing_account: requiredId(
      row.billing_account,
      "subscription billing account",
    ),
    source: source as QuotaSubscriptionSource,
    status: status as QuotaSubscriptionStatus,
    current_period_end: optionalDateTime(row.current_period_end),
    trial_start: optionalDateTime(row.trial_start),
    trial_end: optionalDateTime(row.trial_end),
    paid_through: optionalDateTime(row.paid_through),
    grace_until: optionalDateTime(row.grace_until),
    cancel_at_period_end: row.cancel_at_period_end === true,
    cancel_at: optionalDateTime(row.cancel_at),
    canceled_at: optionalDateTime(row.canceled_at),
    expires_at: optionalDateTime(row.expires_at),
  });
}

function overrideFromRow(
  row: UnknownRecord | undefined,
): EntitlementOverrideRevision | undefined {
  if (!row) return undefined;
  return Object.freeze({
    id: requiredId(row.id, "override revision"),
    workspace: requiredId(row.workspace, "override workspace"),
    revision: integer(row.revision),
    patches: Array.isArray(row.patches)
      ? row.patches as readonly QuotaOverridePatch[]
      : [],
    effective_at: dateTime(row.effective_at, "override effective_at"),
    expires_at: optionalDateTime(row.expires_at),
  });
}

function nextRevision(rows: UnknownRecord[]): number {
  const current = integer(rows[0]?.revision, 0);
  const normalized = Number(current);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new QuotaLifecycleError(
      "entitlement_revision_invalid",
      "entitlement revision is outside the safe integer range",
    );
  }
  return normalized + 1;
}

export class SurrealEntitlementRefreshService
  implements EntitlementRefreshPort
{
  constructor(private readonly db: EntitlementRefreshQueryClient) {}

  async refreshWorkspace(input: {
    workspace: StringRecordId;
    at: DateTime;
    operationKind:
      | "provider_update"
      | "manual_assignment"
      | "plan_rollout"
      | "override_change"
      | "source_expiry";
    actorKind: "provider" | "operator" | "system";
    actorSubject?: string;
    authorizedCapability?: PlatformOperatorCapability;
    requestId?: string;
    correlationId: string;
    causationId: string;
    reason?: string;
  }): Promise<EntitlementRefreshResult> {
    const context = await this.db.query(
      `
        SELECT * FROM ONLY $workspace;
        SELECT * FROM quota_subscription_item
          WHERE workspace = $workspace AND status = "active";
        SELECT * FROM quota_subscription
          WHERE id IN (
            SELECT VALUE subscription
            FROM quota_subscription_item
            WHERE workspace = $workspace AND status = "active"
          );
        SELECT * FROM quota_plan_revision
          WHERE id IN (
            SELECT VALUE plan_revision
            FROM quota_subscription_item
            WHERE workspace = $workspace AND status = "active"
          );
        SELECT * FROM workspace_quota_override
          WHERE workspace = $workspace
          LIMIT 1;
        SELECT active_revision FROM quota_plan
          WHERE plan_key = "retention" AND status = "active"
          LIMIT 1;
        SELECT revision FROM resource_entitlement
          WHERE workspace = $workspace
          ORDER BY revision DESC
          LIMIT 1;
        SELECT revision FROM quota_policy_projection
          WHERE workspace = $workspace
          ORDER BY revision DESC
          LIMIT 1;
      `,
      { workspace: input.workspace },
    );
    const workspaceRow = firstRow(context, 0);
    if (!workspaceRow) {
      throw new QuotaLifecycleError(
        "workspace_not_found",
        "workspace does not exist",
      );
    }
    const subscriptionRows = statementRows(context, 2);
    const planRows = statementRows(context, 3);
    const subscriptions = new Map(
      subscriptionRows.map((row) => [
        requiredId(row.id, "subscription").toString(),
        subscriptionFromRow(row),
      ]),
    );
    const plans = new Map(
      planRows.map((row) => {
        const plan = planRevisionFromRow(row);
        return [plan.id.toString(), plan] as const;
      }),
    );
    const candidates = statementRows(context, 1).map((row) => {
      const subscriptionId = requiredId(
        row.subscription,
        "subscription item subscription",
      );
      const planRevisionId = requiredId(
        row.plan_revision,
        "subscription item plan",
      );
      const subscription = subscriptions.get(subscriptionId.toString());
      const planRevision = plans.get(planRevisionId.toString());
      if (!subscription || !planRevision) {
        throw new QuotaLifecycleError(
          "entitlement_context_invalid",
          "active subscription item has a missing source or plan revision",
        );
      }
      return Object.freeze({
        subscription,
        item: Object.freeze({
          id: requiredId(row.id, "subscription item"),
          subscription: subscriptionId,
          workspace: input.workspace,
          plan_revision: planRevisionId,
          status: "active" as const,
          effective_from: dateTime(
            row.effective_from,
            "subscription item effective_from",
          ),
          effective_until: optionalDateTime(row.effective_until),
        }),
        planRevision,
      });
    });

    const overrideAssignment = firstRow(context, 4);
    const activeOverride = optionalId(
      overrideAssignment?.active_revision,
    );
    const retentionPlan = optionalId(firstRow(context, 5)?.active_revision);
    const [overrideResult, retentionResult, desiredResult] = await Promise.all([
      activeOverride
        ? this.db.query("SELECT * FROM ONLY $override;", {
            override: activeOverride,
          })
        : Promise.resolve([]),
      retentionPlan
        ? this.db.query("SELECT * FROM ONLY $revision;", {
            revision: retentionPlan,
          })
        : Promise.resolve([]),
      workspaceRow.desired_entitlement
        ? this.db.query(
            "SELECT id, source_digest FROM ONLY $entitlement;",
            { entitlement: workspaceRow.desired_entitlement },
          )
        : Promise.resolve([]),
    ]);
    const overrideRevision = overrideFromRow(firstRow(overrideResult));
    const retentionRevisionRow = firstRow(retentionResult);
    const retentionRevision = retentionRevisionRow
      ? planRevisionFromRow(retentionRevisionRow)
      : undefined;
    const currentDesiredRow = firstRow(desiredResult);
    const entitlementRevision = nextRevision(statementRows(context, 6));
    const projectionRevision = nextRevision(statementRows(context, 7));
    const entropy = `${input.workspace.toString()}:${entitlementRevision}`;
    const entitlementId = deterministicId(
      "resource_entitlement",
      entropy,
    );
    const projectionId = deterministicId(
      "quota_policy_projection",
      `${input.workspace.toString()}:${projectionRevision}`,
    );
    const previouslyActivated =
      workspaceRow.status === "active"
      || workspaceRow.applied_entitlement !== undefined;
    const resolution = resolveResourceEntitlement({
      workspace: input.workspace,
      at: input.at,
      previouslyActivated,
      candidates,
      retentionPlanRevision: retentionRevision,
      overrideRevision,
      currentDesired: currentDesiredRow
        ? {
            id: requiredId(currentDesiredRow.id, "current entitlement"),
            source_digest: requiredString(
              currentDesiredRow.source_digest,
              "current entitlement digest",
            ),
          }
        : undefined,
      nextEntitlement: {
        id: entitlementId,
        revision: entitlementRevision,
      },
      correlationId: input.correlationId,
      causationId: input.causationId,
    });

    const operation = deterministicId(
      "entitlement_operation",
      input.causationId,
      input.operationKind,
    );
    if (resolution.kind === "unchanged") {
      await this.persistNoChangeOperation(input, operation);
      return Object.freeze({ entitlementOperation: operation });
    }
    if (resolution.kind === "unresolved") {
      throw new QuotaLifecycleError(
        "workspace_has_no_resource_source",
        "workspace has no eligible resource entitlement source",
      );
    }

    const compiled = compileQuotaPolicy({
      projection: {
        id: projectionId,
        revision: projectionRevision,
        createdAt: input.at,
      },
      entitlement: resolution.entitlement,
    });
    const materialization = deterministicId(
      "quota_materialization_operation",
      input.workspace.toString(),
      projectionId.toString(),
    );
    await this.db.query(
      `
        BEGIN TRANSACTION;
        LET $currentDesired = (
          SELECT VALUE desired_entitlement
          FROM ONLY $workspace
        );
        IF $currentDesired != $expectedDesired {
          THROW "entitlement-refresh-conflict";
        };
        IF !record::exists($entitlement) {
          CREATE $entitlement CONTENT $entitlementContent;
        };
        IF !record::exists($projection) {
          CREATE $projection CONTENT $projectionContent;
        };
        IF !record::exists($operation) {
          CREATE $operation CONTENT $operationContent;
        };
        IF !record::exists($materialization) {
          CREATE $materialization CONTENT {
            workspace: $workspace,
            entitlement: $entitlement,
            projection: $projection,
            status: "pending",
            idempotency_key: $materializationKey,
            request_id: $requestId,
            reconcile_mode: "normal",
            attempt_count: 0,
            fencing_token: 0,
            correlation_id: $correlationId,
            causation_id: $materializationCausation
          };
        };
        UPDATE quota_materialization_operation SET
          status = "superseded",
          superseded_by = $materialization,
          completed_at = time::now()
        WHERE workspace = $workspace
          AND id != $materialization
          AND status = "pending";
        UPDATE $workspace SET
          desired_entitlement = $entitlement,
          desired_quota_projection = $projection;
        LET $runtime = (
          SELECT VALUE id
          FROM workspace_quota_runtime
          WHERE workspace = $workspace
          LIMIT 1
        )[0];
        IF $runtime = NONE {
          CREATE workspace_quota_runtime CONTENT {
            workspace: $workspace,
            sync_state: "pending",
            service_mode: "retention",
            quota_compliance: "unknown",
            capacity_state: "unknown",
            auto_reconcile: true,
            usage_trusted: false,
            fencing_token: 0
          };
        } ELSE {
          UPDATE $runtime SET sync_state = "pending";
        };
        COMMIT TRANSACTION;
      `,
      {
        workspace: input.workspace,
        expectedDesired: optionalId(workspaceRow.desired_entitlement),
        entitlement: resolution.entitlement.id,
        entitlementContent: omitNullishSurrealFields({
          workspace: resolution.entitlement.workspace,
          revision: resolution.entitlement.revision,
          source_type: resolution.entitlement.source_type,
          subscription_item: resolution.entitlement.subscription_item,
          plan_revision: resolution.entitlement.plan_revision,
          override_revision: resolution.entitlement.override_revision,
          service_mode: resolution.entitlement.service_mode,
          rules: resolution.entitlement.rules,
          source_digest: resolution.entitlement.source_digest,
          effective_at: resolution.entitlement.effective_at,
          effective_until: resolution.entitlement.effective_until,
          correlation_id: resolution.entitlement.correlation_id,
          causation_id: resolution.entitlement.causation_id,
        }),
        projection: compiled.projection.id,
        projectionContent: omitNullishSurrealFields({
          workspace: compiled.projection.workspace,
          entitlement: compiled.projection.entitlement,
          revision: compiled.projection.revision,
          compiler_version: compiled.projection.compiler_version,
          native_capability: compiled.projection.native_capability,
          native_contract_major: compiled.projection.native_contract_major,
          info_format_version: compiled.projection.info_format_version,
          rules: compiled.projection.rules,
          rule_labels: compiled.projection.rule_labels,
          canonical_digest: compiled.projection.canonical_digest,
          correlation_id: compiled.projection.correlation_id,
          causation_id: compiled.projection.causation_id,
        }),
        operation,
        operationContent: this.operationContent(
          input,
          "succeeded",
          operation,
          resolution.entitlement.id,
          compiled.projection.id,
        ),
        materialization,
        materializationKey:
          `materialize:${input.workspace.toString()}:${compiled.projection.id.toString()}`,
        materializationCausation: operation.toString(),
        requestId: input.requestId,
        correlationId: input.correlationId,
      },
    );
    return Object.freeze({
      entitlementOperation: operation,
      materializationOperation: materialization,
    });
  }

  private async persistNoChangeOperation(
    input: Parameters<EntitlementRefreshPort["refreshWorkspace"]>[0],
    operation: StringRecordId,
  ): Promise<void> {
    await this.db.query(
      `
        IF !record::exists($operation) {
          CREATE $operation CONTENT $content;
        };
      `,
      {
        operation,
        content: this.operationContent(input, "no_change", operation),
      },
    );
  }

  private operationContent(
    input: Parameters<EntitlementRefreshPort["refreshWorkspace"]>[0],
    outcome: "succeeded" | "no_change",
    operation: StringRecordId,
    entitlement?: StringRecordId,
    projection?: StringRecordId,
  ): Record<string, unknown> {
    return omitNullishSurrealFields({
      workspace: input.workspace,
      operation_kind: input.operationKind,
      outcome,
      entitlement,
      projection,
      idempotency_key: `entitlement:${operation.toString()}`,
      request_id: input.requestId,
      actor_kind: input.actorKind,
      actor_subject: input.actorSubject,
      authorized_capability: input.authorizedCapability,
      reason: input.reason,
      effective_at: input.at,
      correlation_id: input.correlationId,
      causation_id: input.causationId,
    });
  }
}
