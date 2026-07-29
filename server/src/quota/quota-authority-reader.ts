import type {
  NativeQuotaLimit,
  NativeQuotaResource,
  NativeQuotaSelector,
  PlatformOperatorCapability,
  QuotaCapacityState,
  QuotaCompliance,
  QuotaServiceMode,
  QuotaSubscriptionStatus,
  QuotaSyncState,
} from "@surreal-ck/shared/native-quota";
import { getRootDatabaseSession } from "../db/root-connection";
import {
  toIsoDateTimeString,
  toStringRecordId,
} from "../db/surreal-values";
import type {
  QuotaAuthorityEntitlement,
  QuotaBillingAuthority,
  QuotaAuthorityProjection,
  QuotaAuthorityReader,
  QuotaAuthorityRule,
  QuotaReadActor,
  QuotaWorkspaceAuthority,
} from "./quota-read-service";

type Queryable = {
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

type UnknownRecord = Record<string, unknown>;

type QuotaAuthorityReaderOptions = Readonly<{
  db?: Queryable;
  getDb?: () => Promise<Queryable>;
}>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statementRows(result: unknown): unknown[] {
  if (!Array.isArray(result)) return [];
  const statement = result[0];
  if (Array.isArray(statement)) return statement;
  return statement === undefined || statement === null ? [] : [statement];
}

function firstRecord(result: unknown): UnknownRecord | undefined {
  return statementRows(result).find(isRecord);
}

function valueRows(result: unknown): unknown[] {
  return statementRows(result).flatMap((value) =>
    Array.isArray(value) ? value : [value]
  );
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`quota authority row is missing ${field}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordString(value: unknown, field: string): string {
  const record = toStringRecordId(value);
  if (!record) throw new Error(`quota authority row is missing ${field}`);
  return record.toString();
}

function integer(value: unknown, field: string): number | bigint {
  if (
    typeof value !== "bigint"
    && !(typeof value === "number" && Number.isSafeInteger(value))
  ) {
    throw new Error(`quota authority row has invalid ${field}`);
  }
  return value;
}

function dateTime(value: unknown, field: string): string {
  const normalized = toIsoDateTimeString(value);
  if (!normalized) throw new Error(`quota authority row is missing ${field}`);
  return normalized;
}

function nestedRecord(value: unknown): UnknownRecord | undefined {
  if (isRecord(value)) return value;
  return undefined;
}

function parseLimit(value: unknown): NativeQuotaLimit | null {
  if (!isRecord(value)) return null;
  if (value.kind === "unlimited") return { kind: "unlimited" };
  if (value.kind !== "finite") return null;
  if (
    typeof value.value !== "bigint"
    && !(typeof value.value === "number" && Number.isSafeInteger(value.value))
  ) {
    return null;
  }
  return { kind: "finite", value: value.value };
}

function parseSelector(value: unknown): NativeQuotaSelector | null {
  if (!isRecord(value)) return null;
  if (value.kind === "exact" && typeof value.table === "string") {
    return { kind: "exact", table: value.table };
  }
  if (value.kind === "regex" && typeof value.pattern === "string") {
    return { kind: "regex", pattern: value.pattern };
  }
  return null;
}

function parseResource(value: unknown): NativeQuotaResource | null {
  return value === "table" || value === "field" || value === "record"
    ? value
    : null;
}

function parseProjection(value: unknown): QuotaAuthorityProjection | undefined {
  const row = nestedRecord(value);
  if (!row) return undefined;
  const rawRules = Array.isArray(row.rules) ? row.rules : [];
  const rawLabels = Array.isArray(row.rule_labels) ? row.rule_labels : [];
  const labels = new Map<string, UnknownRecord>();
  for (const rawLabel of rawLabels) {
    if (!isRecord(rawLabel) || typeof rawLabel.rule_id !== "string") continue;
    labels.set(rawLabel.rule_id, rawLabel);
  }

  const rules: QuotaAuthorityRule[] = [];
  for (const rawRule of rawRules) {
    if (!isRecord(rawRule) || typeof rawRule.rule_id !== "string") continue;
    const label = labels.get(rawRule.rule_id);
    const resource = parseResource(rawRule.resource);
    const selector = parseSelector(rawRule.selector);
    const limit = parseLimit(rawRule.limit);
    if (!label || !resource || !selector || !limit) continue;
    if (
      typeof label.rule_key !== "string"
      || typeof label.customer_label !== "string"
    ) {
      continue;
    }
    rules.push({
      rule_id: rawRule.rule_id,
      rule_key: label.rule_key,
      resource,
      selector,
      limit,
      customer_label: label.customer_label,
      ...(typeof label.customer_description === "string"
        ? { customer_description: label.customer_description }
        : {}),
    });
  }

  return {
    record: recordString(row.id, "projection.id"),
    canonicalDigest: requiredString(
      row.canonical_digest,
      "projection.canonical_digest",
    ),
    rules,
  };
}

function sourceType(value: unknown): QuotaAuthorityEntitlement["source"] {
  if (
    value === "paid"
    || value === "trial"
    || value === "contract"
    || value === "manual"
    || value === "retention"
  ) {
    return value;
  }
  throw new Error("quota authority row has invalid entitlement source");
}

function serviceMode(value: unknown): QuotaServiceMode {
  if (value === "standard" || value === "grace" || value === "retention") {
    return value;
  }
  throw new Error("quota authority row has invalid service mode");
}

function parseEntitlement(value: unknown): QuotaAuthorityEntitlement | undefined {
  const row = nestedRecord(value);
  if (!row) return undefined;
  const planRevision = nestedRecord(row.plan_revision);
  const plan = nestedRecord(planRevision?.plan);
  if (!planRevision || !plan) {
    throw new Error("quota entitlement plan relation was not fetched");
  }
  const override = nestedRecord(row.override_revision);

  return {
    record: recordString(row.id, "entitlement.id"),
    revision: integer(row.revision, "entitlement.revision"),
    source: sourceType(row.source_type),
    serviceMode: serviceMode(row.service_mode),
    effectiveAt: dateTime(row.effective_at, "entitlement.effective_at"),
    ...(toIsoDateTimeString(row.effective_until)
      ? { effectiveUntil: toIsoDateTimeString(row.effective_until)! }
      : {}),
    planKey: requiredString(plan.plan_key, "plan.plan_key"),
    planName: requiredString(plan.display_name, "plan.display_name"),
    planRevision: integer(planRevision.revision, "plan_revision.revision"),
    ...(typeof override?.customer_reason === "string"
      ? { adjustment: override.customer_reason }
      : {}),
  };
}

function parseRuntime(result: unknown): QuotaWorkspaceAuthority["runtime"] {
  const row = firstRecord(result);
  const sync = row?.sync_state;
  const compliance = row?.quota_compliance;
  const capacity = row?.capacity_state;
  const mode = row?.service_mode;
  const ledger = row?.ledger_state;
  return {
    sync: (
      sync === "pending"
      || sync === "applying"
      || sync === "in_sync"
      || sync === "error"
      || sync === "external_drift"
      || sync === "paused"
    ) ? sync satisfies QuotaSyncState : "pending",
    compliance: (
      compliance === "compliant"
      || compliance === "over_limit"
      || compliance === "unknown"
    ) ? compliance satisfies QuotaCompliance : "unknown",
    capacity: (
      capacity === "normal"
      || capacity === "warning"
      || capacity === "critical"
      || capacity === "at_limit"
      || capacity === "over_limit"
      || capacity === "unknown"
    ) ? capacity satisfies QuotaCapacityState : "unknown",
    serviceMode:
      mode === "standard" || mode === "grace" || mode === "retention"
        ? mode
        : "standard",
    ledger:
      ledger === "uninitialized"
      || ledger === "rebuilding"
      || ledger === "ready"
      || ledger === "corrupt"
        ? ledger
        : null,
    usageTrusted: row?.usage_trusted === true,
    autoReconcile: row?.auto_reconcile !== false,
    ...(typeof row?.native_observed_generation === "number"
      || typeof row?.native_observed_generation === "bigint"
      ? { nativeGeneration: row.native_observed_generation }
      : {}),
    ...(optionalString(row?.native_observed_digest)
      ? { nativeDigest: optionalString(row?.native_observed_digest)! }
      : {}),
    ...(optionalString(row?.last_sync_error_code)
      ? { lastSyncErrorCode: optionalString(row?.last_sync_error_code)! }
      : {}),
    updatedAt:
      toIsoDateTimeString(row?.updated_at)
      ?? new Date(0).toISOString(),
  };
}

function parseOperatorCapabilities(result: unknown): PlatformOperatorCapability[] {
  const allowed = new Set<PlatformOperatorCapability>([
    "quota.read",
    "subscription.manage",
    "override.manage",
    "reconcile.audit",
    "drift.manage",
    "ledger.rebuild",
  ]);
  return valueRows(result).filter(
    (value): value is PlatformOperatorCapability =>
      typeof value === "string"
      && allowed.has(value as PlatformOperatorCapability),
  );
}

function parseSubscriptionStatus(value: unknown): QuotaSubscriptionStatus | undefined {
  if (
    value === "pending"
    || value === "trialing"
    || value === "active"
    || value === "past_due"
    || value === "paused"
    || value === "canceled"
    || value === "expired"
  ) {
    return value;
  }
  return undefined;
}

function identityCondition(actor: QuotaReadActor): Readonly<{
  sql: string;
  params: Record<string, unknown>;
}> {
  const email = actor.email?.trim().toLowerCase();
  return email
    ? {
        sql: "(subject = $subject OR (subject = NONE AND email = $email))",
        params: { subject: actor.subject, email },
      }
    : {
        sql: "subject = $subject",
        params: { subject: actor.subject },
      };
}

export class SurrealQuotaAuthorityReader implements QuotaAuthorityReader {
  private readonly getDb: () => Promise<Queryable>;

  constructor(options: QuotaAuthorityReaderOptions = {}) {
    this.getDb = options.db
      ? async () => options.db!
      : options.getDb ?? (() => getRootDatabaseSession("_system"));
  }

  async findWorkspaceAuthority(input: Readonly<{
    slug: string;
    actor: QuotaReadActor;
  }>): Promise<QuotaWorkspaceAuthority | null> {
    const db = await this.getDb();
    const workspaceResult = await db.query(
      `
        SELECT *
        FROM ONLY workspace
        WHERE slug = $slug
          AND status != "archived"
        FETCH
          desired_entitlement,
          desired_entitlement.plan_revision,
          desired_entitlement.plan_revision.plan,
          desired_entitlement.override_revision,
          applied_entitlement,
          applied_entitlement.plan_revision,
          applied_entitlement.plan_revision.plan,
          applied_entitlement.override_revision,
          desired_quota_projection,
          applied_quota_projection;
      `,
      { slug: input.slug },
    );
    const workspace = firstRecord(workspaceResult);
    if (!workspace) return null;
    const workspaceId = toStringRecordId(workspace.id);
    if (!workspaceId) throw new Error("workspace authority row has no record id");

    const identity = identityCondition(input.actor);
    const [membershipResult, operatorResult, runtimeResult, itemResult] =
      await Promise.all([
        db.query(
          `
            SELECT VALUE role
            FROM user_workspace_index
            WHERE workspace = $workspace
              AND disabled_at = NONE
              AND ${identity.sql}
            LIMIT 1;
          `,
          { workspace: workspaceId, ...identity.params },
        ),
        db.query(
          `
            SELECT VALUE capability
            FROM platform_operator_capability
            WHERE status = "active"
              AND operator IN (
                SELECT VALUE id
                FROM platform_operator
                WHERE subject = $subject
                  AND status = "active"
              );
          `,
          { subject: input.actor.subject },
        ),
        db.query(
          `
            SELECT *
            FROM ONLY workspace_quota_runtime
            WHERE workspace = $workspace;
          `,
          { workspace: workspaceId },
        ),
        db.query(
          `
            SELECT *
            FROM quota_subscription_item
            WHERE workspace = $workspace
            ORDER BY effective_from DESC
            LIMIT 1
            FETCH subscription, subscription.billing_account;
          `,
          { workspace: workspaceId },
        ),
      ]);

    const workspaceRole = valueRows(membershipResult).find(
      (role) => role === "admin" || role === "participant",
    ) as "admin" | "participant" | undefined;
    const item = firstRecord(itemResult);
    const subscription = nestedRecord(item?.subscription);
    const billingAccount = nestedRecord(subscription?.billing_account);
    const billingAccountId = toStringRecordId(billingAccount?.id);
    let billingRole: "owner" | "admin" | "viewer" | undefined;
    if (billingAccountId) {
      const billingMembership = await db.query(
        `
          SELECT VALUE role
          FROM billing_account_member
          WHERE billing_account = $billing_account
            AND subject = $subject
            AND status = "active"
          LIMIT 1;
        `,
        {
          billing_account: billingAccountId,
          subject: input.actor.subject,
        },
      );
      billingRole = valueRows(billingMembership).find(
        (role) => role === "owner" || role === "admin" || role === "viewer",
      ) as "owner" | "admin" | "viewer" | undefined;
    }

    const runtime = parseRuntime(runtimeResult);
    const workspaceUpdatedAt =
      toIsoDateTimeString(workspace.updated_at) ?? runtime.updatedAt;
    const commercialStateAt =
      Date.parse(workspaceUpdatedAt) >= Date.parse(runtime.updatedAt)
        ? workspaceUpdatedAt
        : runtime.updatedAt;
    const desiredEntitlement = parseEntitlement(
      workspace.desired_entitlement,
    );
    const appliedEntitlement = parseEntitlement(
      workspace.applied_entitlement,
    );
    const desiredProjection = parseProjection(
      workspace.desired_quota_projection,
    );
    const appliedProjection = parseProjection(
      workspace.applied_quota_projection,
    );
    const subscriptionStatus = parseSubscriptionStatus(subscription?.status);
    const subscriptionId = toStringRecordId(subscription?.id);
    const subscriptionSource = subscription?.source;
    const normalizedSubscriptionSource:
      | "provider"
      | "manual"
      | "contract"
      | undefined =
        subscriptionSource === "provider"
        || subscriptionSource === "manual"
        || subscriptionSource === "contract"
          ? subscriptionSource
          : undefined;
    const subscriptionAuthority =
      subscriptionId
      && billingAccountId
      && typeof billingAccount?.account_key === "string"
      && normalizedSubscriptionSource
      && subscriptionStatus
        ? {
            id: subscriptionId.toString(),
            source: normalizedSubscriptionSource,
            status: subscriptionStatus,
            current_period_end:
              toIsoDateTimeString(subscription?.current_period_end) ?? null,
            paid_through:
              toIsoDateTimeString(subscription?.paid_through) ?? null,
            grace_until:
              toIsoDateTimeString(subscription?.grace_until) ?? null,
            cancel_at_period_end:
              subscription?.cancel_at_period_end === true,
            cancel_at:
              toIsoDateTimeString(subscription?.cancel_at) ?? null,
            billingAccountRecord: billingAccountId.toString(),
            billingAccountKey: billingAccount.account_key,
            billingAccountName: requiredString(
              billingAccount.name,
              "billing account name",
            ),
          }
        : undefined;

    return {
      workspace: {
        record: workspaceId.toString(),
        slug: requiredString(workspace.slug, "workspace.slug"),
        name: requiredString(workspace.name, "workspace.name"),
        database: requiredString(workspace.db_name, "workspace.db_name"),
      },
      ...(workspaceRole ? { workspaceRole } : {}),
      ...(billingRole ? { billingRole } : {}),
      operatorCapabilities: parseOperatorCapabilities(operatorResult),
      ...(desiredEntitlement ? { desiredEntitlement } : {}),
      ...(appliedEntitlement ? { appliedEntitlement } : {}),
      ...(desiredProjection ? { desiredProjection } : {}),
      ...(appliedProjection ? { appliedProjection } : {}),
      ...(subscriptionStatus ? { subscriptionStatus } : {}),
      ...(subscriptionAuthority ? { subscription: subscriptionAuthority } : {}),
      runtime,
      commercialStateAt,
    };
  }

  async findBillingAuthority(input: Readonly<{
    accountKey: string;
    actor: QuotaReadActor;
  }>): Promise<QuotaBillingAuthority | null> {
    const db = await this.getDb();
    const accountResult = await db.query(
      `
        SELECT id, account_key, name
        FROM ONLY billing_account
        WHERE account_key = $account_key
          AND status = "active";
      `,
      { account_key: input.accountKey },
    );
    const account = firstRecord(accountResult);
    const accountId = toStringRecordId(account?.id);
    if (!account || !accountId) return null;

    const membershipResult = await db.query(
      `
        SELECT VALUE role
        FROM billing_account_member
        WHERE billing_account = $billing_account
          AND subject = $subject
          AND status = "active"
          AND role INSIDE ["owner", "admin"]
        LIMIT 1;
      `,
      {
        billing_account: accountId,
        subject: input.actor.subject,
      },
    );
    const authorized = valueRows(membershipResult).some(
      (role) => role === "owner" || role === "admin",
    );
    if (!authorized) return null;

    const workspaceResult = await db.query(
      `
        SELECT workspace
        FROM quota_subscription_item
        WHERE subscription IN (
          SELECT VALUE id
          FROM quota_subscription
          WHERE billing_account = $billing_account
        )
          AND status INSIDE ["active", "scheduled"]
        GROUP BY workspace
        FETCH workspace;
      `,
      { billing_account: accountId },
    );
    const slugs = statementRows(workspaceResult).flatMap((row) => {
      if (!isRecord(row)) return [];
      const workspace = nestedRecord(row.workspace);
      return typeof workspace?.slug === "string" ? [workspace.slug] : [];
    });
    const workspaces = (
      await Promise.all(
        slugs.map((slug) =>
          this.findWorkspaceAuthority({
            slug,
            actor: input.actor,
          })
        ),
      )
    ).filter((workspace): workspace is QuotaWorkspaceAuthority => workspace !== null);

    return {
      account: {
        accountKey: requiredString(account.account_key, "billing_account.account_key"),
        name: requiredString(account.name, "billing_account.name"),
      },
      workspaces,
    };
  }
}
