import {
  PLATFORM_OPERATOR_CAPABILITIES,
  QUOTA_API_FORMAT_VERSION,
  type NativeQuotaResource,
  type PlatformOperatorCapability,
  type QuotaApiCount,
  type QuotaCapacityState,
  type QuotaOpsContextView,
  type QuotaOpsPlanRevision,
  type QuotaOpsSearchResult,
  type QuotaOpsSearchView,
  type QuotaOpsTimelineItem,
  type QuotaOpsTimelineView,
  type QuotaSyncState,
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

type UnknownRecord = Record<string, unknown>;

export type QuotaOpsConsoleActor = Readonly<{ subject: string }>;

export interface QuotaOpsConsolePort {
  getContext(input: Readonly<{
    actor: QuotaOpsConsoleActor;
  }>): Promise<QuotaOpsContextView | null>;
  search(input: Readonly<{
    actor: QuotaOpsConsoleActor;
    query: string;
    limit: number;
  }>): Promise<QuotaOpsSearchView | null>;
  getTimeline(input: Readonly<{
    actor: QuotaOpsConsoleActor;
    slug: string;
    limit: number;
  }>): Promise<QuotaOpsTimelineView | null>;
  findPlanRevision(input: Readonly<{
    actor: QuotaOpsConsoleActor;
    id: StringRecordId;
  }>): Promise<QuotaOpsPlanRevision | null>;
}

type QuotaOpsConsoleOptions = Readonly<{
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

function rows(result: unknown): UnknownRecord[] {
  return statementRows(result).filter(isRecord);
}

function first(result: unknown): UnknownRecord | undefined {
  return rows(result)[0];
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`quota ops row is missing ${field}`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function recordString(value: unknown, field: string): string {
  const id = toStringRecordId(value);
  if (!id) throw new Error(`quota ops row is missing ${field}`);
  return id.toString();
}

function count(value: unknown): QuotaApiCount {
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new Error("quota ops row contains an invalid count");
}

function dateTime(value: unknown, field: string): string {
  const valueAsIso = toIsoDateTimeString(value);
  if (!valueAsIso) throw new Error(`quota ops row is missing ${field}`);
  return valueAsIso;
}

function nested(value: unknown): UnknownRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function capability(value: unknown): PlatformOperatorCapability | null {
  return typeof value === "string"
      && (PLATFORM_OPERATOR_CAPABILITIES as readonly string[]).includes(value)
    ? value as PlatformOperatorCapability
    : null;
}

function syncState(value: unknown): QuotaSyncState {
  return value === "pending"
      || value === "applying"
      || value === "in_sync"
      || value === "error"
      || value === "external_drift"
      || value === "paused"
    ? value
    : "pending";
}

function capacityState(value: unknown): QuotaCapacityState {
  return value === "normal"
      || value === "warning"
      || value === "critical"
      || value === "at_limit"
      || value === "over_limit"
      || value === "unknown"
    ? value
    : "unknown";
}

function parsePlanRevision(row: UnknownRecord): QuotaOpsPlanRevision {
  const plan = nested(row.plan);
  if (!plan) throw new Error("quota plan revision did not fetch plan");
  const templateKind = row.template_kind;
  if (
    templateKind !== "commercial"
    && templateKind !== "trial"
    && templateKind !== "contract"
    && templateKind !== "retention"
  ) {
    throw new Error("quota plan revision has invalid template_kind");
  }
  const rules = Array.isArray(row.rules)
    ? row.rules.flatMap((raw) => {
        if (!isRecord(raw)) return [];
        const resource = raw.resource;
        const selector = nested(raw.selector);
        const limit = nested(raw.limit);
        if (
          (resource !== "table"
            && resource !== "field"
            && resource !== "record")
          || (selector?.kind !== "exact" && selector?.kind !== "regex")
          || typeof selector.value !== "string"
          || (limit?.kind !== "finite" && limit?.kind !== "unlimited")
          || typeof raw.rule_key !== "string"
          || typeof raw.customer_label !== "string"
        ) {
          return [];
        }
        const normalizedResource: NativeQuotaResource = resource;
        const selectorKind: "exact" | "regex" = selector.kind;
        const normalizedLimit =
          limit.kind === "unlimited"
            ? { kind: "unlimited" as const }
            : {
                kind: "finite" as const,
                value: count(limit.value),
              };
        return [{
          rule_key: raw.rule_key,
          resource: normalizedResource,
          label: raw.customer_label,
          description:
            typeof raw.customer_description === "string"
              ? raw.customer_description
              : null,
          selector: {
            kind: selectorKind,
            value: selector.value,
          },
          limit: normalizedLimit,
        }];
      })
    : [];
  return {
    id: recordString(row.id, "plan revision id"),
    plan_key: requiredString(plan.plan_key, "plan key"),
    plan_name: requiredString(plan.display_name, "plan name"),
    revision: count(row.revision),
    template_kind: templateKind,
    published_at: dateTime(row.published_at, "published_at"),
    rules,
  };
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function timelineItem(input: QuotaOpsTimelineItem): QuotaOpsTimelineItem {
  return Object.freeze(input);
}

function recordIdWithPrefix(
  value: string,
  prefix: "workspace:" | "billing_account:",
): StringRecordId | null {
  if (!value.startsWith(prefix)) return null;
  if (!/^[a-z_]+:[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    return new StringRecordId(value);
  } catch {
    return null;
  }
}

export class SurrealQuotaOpsConsole implements QuotaOpsConsolePort {
  private readonly getDb: () => Promise<Queryable>;

  constructor(options: QuotaOpsConsoleOptions = {}) {
    this.getDb = options.db
      ? async () => options.db!
      : options.getDb ?? (() => getRootDatabaseSession("_system"));
  }

  private async capabilities(
    db: Queryable,
    subject: string,
  ): Promise<PlatformOperatorCapability[]> {
    const result = await db.query(
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
      { subject },
    );
    return statementRows(result).flatMap((item) => {
      const parsed = capability(item);
      return parsed ? [parsed] : [];
    }).sort();
  }

  private async authorized(
    db: Queryable,
    actor: QuotaOpsConsoleActor,
  ): Promise<PlatformOperatorCapability[] | null> {
    const capabilities = await this.capabilities(db, actor.subject);
    return capabilities.includes("quota.read") ? capabilities : null;
  }

  async getContext(input: Readonly<{
    actor: QuotaOpsConsoleActor;
  }>): Promise<QuotaOpsContextView | null> {
    const db = await this.getDb();
    const capabilities = await this.authorized(db, input.actor);
    if (!capabilities) return null;
    const result = await db.query(
      `
        SELECT *
        FROM quota_plan_revision
        WHERE template_kind INSIDE ["commercial", "contract"]
          AND plan IN (
          SELECT VALUE id
          FROM quota_plan
          WHERE status = "active"
        )
        ORDER BY published_at DESC
        LIMIT 100
        FETCH plan;
      `,
    );
    return {
      format_version: QUOTA_API_FORMAT_VERSION,
      viewer: {
        subject: input.actor.subject,
        capabilities,
      },
      plans: rows(result).map(parsePlanRevision),
    };
  }

  async findPlanRevision(input: Readonly<{
    actor: QuotaOpsConsoleActor;
    id: StringRecordId;
  }>): Promise<QuotaOpsPlanRevision | null> {
    const db = await this.getDb();
    if (!await this.authorized(db, input.actor)) return null;
    const result = await db.query(
      "SELECT * FROM ONLY $revision FETCH plan;",
      { revision: input.id },
    );
    const row = first(result);
    return row ? parsePlanRevision(row) : null;
  }

  async search(input: Readonly<{
    actor: QuotaOpsConsoleActor;
    query: string;
    limit: number;
  }>): Promise<QuotaOpsSearchView | null> {
    const db = await this.getDb();
    const capabilities = await this.authorized(db, input.actor);
    if (!capabilities) return null;
    const query = input.query.trim();
    const workspaceId = recordIdWithPrefix(query, "workspace:");
    const accountId = recordIdWithPrefix(query, "billing_account:");
    const [workspaceResult, accountResult, workspaceSubjectResult, billingSubjectResult] =
      await Promise.all([
        db.query(
          workspaceId
            ? `
                SELECT *
                FROM ONLY $workspace
                FETCH
                  applied_entitlement,
                  applied_entitlement.plan_revision,
                  applied_entitlement.plan_revision.plan;
              `
            : `
                SELECT *
                FROM workspace
                WHERE status != "archived"
                  AND (
                    string::lowercase(slug) CONTAINS string::lowercase($query)
                    OR string::lowercase(name) CONTAINS string::lowercase($query)
                  )
                ORDER BY updated_at DESC
                LIMIT $limit
                FETCH
                  applied_entitlement,
                  applied_entitlement.plan_revision,
                  applied_entitlement.plan_revision.plan;
              `,
          workspaceId
            ? { workspace: workspaceId }
            : { query, limit: input.limit },
        ),
        db.query(
          accountId
            ? "SELECT * FROM ONLY $account;"
            : `
                SELECT *
                FROM billing_account
                WHERE status = "active"
                  AND (
                    string::lowercase(account_key) CONTAINS string::lowercase($query)
                    OR string::lowercase(name) CONTAINS string::lowercase($query)
                  )
                ORDER BY updated_at DESC
                LIMIT $limit;
              `,
          accountId
            ? { account: accountId }
            : { query, limit: input.limit },
        ),
        db.query(
          `
            SELECT subject, workspace
            FROM user_workspace_index
            WHERE disabled_at = NONE
              AND string::lowercase(subject) CONTAINS string::lowercase($query)
            LIMIT $limit
            FETCH workspace;
          `,
          { query, limit: input.limit },
        ),
        db.query(
          `
            SELECT subject, billing_account
            FROM billing_account_member
            WHERE status = "active"
              AND string::lowercase(subject) CONTAINS string::lowercase($query)
            LIMIT $limit
            FETCH billing_account;
          `,
          { query, limit: input.limit },
        ),
      ]);

    const workspaceResults = await Promise.all(rows(workspaceResult).map(
      async (workspace): Promise<QuotaOpsSearchResult> => {
        const workspaceRecord = toStringRecordId(workspace.id);
        if (!workspaceRecord) throw new Error("workspace search row has no id");
        const [runtimeResult, itemResult] = await Promise.all([
          db.query(
            `
              SELECT sync_state, capacity_state
              FROM ONLY workspace_quota_runtime
              WHERE workspace = $workspace;
            `,
            { workspace: workspaceRecord },
          ),
          db.query(
            `
              SELECT subscription, effective_from
              FROM quota_subscription_item
              WHERE workspace = $workspace
              ORDER BY effective_from DESC
              LIMIT 1
              FETCH subscription, subscription.billing_account;
            `,
            { workspace: workspaceRecord },
          ),
        ]);
        const runtime = first(runtimeResult);
        const subscription = nested(first(itemResult)?.subscription);
        const account = nested(subscription?.billing_account);
        const entitlement = nested(workspace.applied_entitlement);
        const revision = nested(entitlement?.plan_revision);
        const plan = nested(revision?.plan);
        return {
          kind: "workspace",
          workspace: {
            id: workspaceRecord.toString(),
            slug: requiredString(workspace.slug, "workspace slug"),
            name: requiredString(workspace.name, "workspace name"),
          },
          billing_account: account
            ? {
                id: recordString(account.id, "billing account id"),
                account_key: requiredString(
                  account.account_key,
                  "billing account key",
                ),
                name: requiredString(account.name, "billing account name"),
              }
            : null,
          applied_plan_name: optionalString(plan?.display_name),
          sync: syncState(runtime?.sync_state),
          capacity: capacityState(runtime?.capacity_state),
        };
      },
    ));

    const accountResults = await Promise.all(rows(accountResult).map(
      async (account): Promise<QuotaOpsSearchResult> => {
        const accountRecord = toStringRecordId(account.id);
        if (!accountRecord) throw new Error("billing search row has no id");
        const itemResult = await db.query(
          `
            SELECT workspace
            FROM quota_subscription_item
            WHERE subscription IN (
              SELECT VALUE id
              FROM quota_subscription
              WHERE billing_account = $billingAccount
            )
              AND status INSIDE ["active", "scheduled"]
            FETCH workspace;
          `,
          { billingAccount: accountRecord },
        );
        const workspaceSlugs = unique(rows(itemResult).flatMap((row) => {
          const workspace = nested(row.workspace);
          return typeof workspace?.slug === "string" ? [workspace.slug] : [];
        }));
        return {
          kind: "billing_account",
          billing_account: {
            id: accountRecord.toString(),
            account_key: requiredString(account.account_key, "account key"),
            name: requiredString(account.name, "account name"),
          },
          workspace_count: workspaceSlugs.length,
          workspace_slugs: workspaceSlugs,
        };
      },
    ));

    const subjects = new Map<string, {
      workspaceSlugs: string[];
      accountKeys: string[];
    }>();
    for (const row of rows(workspaceSubjectResult)) {
      const subject = optionalString(row.subject);
      const workspace = nested(row.workspace);
      if (!subject || typeof workspace?.slug !== "string") continue;
      const value = subjects.get(subject) ?? {
        workspaceSlugs: [],
        accountKeys: [],
      };
      value.workspaceSlugs.push(workspace.slug);
      subjects.set(subject, value);
    }
    for (const row of rows(billingSubjectResult)) {
      const subject = optionalString(row.subject);
      const account = nested(row.billing_account);
      if (!subject || typeof account?.account_key !== "string") continue;
      const value = subjects.get(subject) ?? {
        workspaceSlugs: [],
        accountKeys: [],
      };
      value.accountKeys.push(account.account_key);
      subjects.set(subject, value);
    }
    const subjectResults: QuotaOpsSearchResult[] = [...subjects.entries()]
      .slice(0, input.limit)
      .map(([subject, value]) => ({
        kind: "subject",
        subject,
        workspace_slugs: unique(value.workspaceSlugs),
        billing_account_keys: unique(value.accountKeys),
      }));

    return {
      format_version: QUOTA_API_FORMAT_VERSION,
      viewer: {
        subject: input.actor.subject,
        capabilities,
      },
      query,
      results: [
        ...workspaceResults,
        ...accountResults,
        ...subjectResults,
      ].slice(0, input.limit),
    };
  }

  async getTimeline(input: Readonly<{
    actor: QuotaOpsConsoleActor;
    slug: string;
    limit: number;
  }>): Promise<QuotaOpsTimelineView | null> {
    const db = await this.getDb();
    if (!await this.authorized(db, input.actor)) return null;
    const workspaceResult = await db.query(
      `
        SELECT id, slug, name
        FROM ONLY workspace
        WHERE slug = $slug
          AND status != "archived";
      `,
      { slug: input.slug },
    );
    const workspace = first(workspaceResult);
    const workspaceId = toStringRecordId(workspace?.id);
    if (!workspace || !workspaceId) return null;

    const [intentResult, entitlementResult, operationResult, auditResult] =
      await Promise.all([
        db.query(
          `
            SELECT *
            FROM quota_operator_intent
            WHERE workspace = $workspace
            ORDER BY created_at DESC
            LIMIT $limit;
          `,
          { workspace: workspaceId, limit: input.limit },
        ),
        db.query(
          `
            SELECT *
            FROM entitlement_operation
            WHERE workspace = $workspace
            ORDER BY completed_at DESC
            LIMIT $limit;
          `,
          { workspace: workspaceId, limit: input.limit },
        ),
        db.query(
          `
            SELECT *
            FROM quota_materialization_operation
            WHERE workspace = $workspace
            ORDER BY updated_at DESC
            LIMIT $limit;
          `,
          { workspace: workspaceId, limit: input.limit },
        ),
        db.query(
          `
            SELECT *
            FROM quota_audit_event
            WHERE workspace = $workspace
            ORDER BY occurred_at DESC
            LIMIT $limit;
          `,
          { workspace: workspaceId, limit: input.limit },
        ),
      ]);

    const intentRows = rows(intentResult);
    const operationRows = rows(operationResult);
    const intentIds = intentRows.flatMap((row) => {
      const id = toStringRecordId(row.id);
      return id ? [id] : [];
    });
    const operationIds = operationRows.flatMap((row) => {
      const id = toStringRecordId(row.id);
      return id ? [id] : [];
    });
    const [intentStateResult, attemptResult] = await Promise.all([
      intentIds.length === 0
        ? Promise.resolve([])
        : db.query(
            `
              SELECT *
              FROM quota_operator_intent_state
              WHERE intent INSIDE $intents;
            `,
            { intents: intentIds },
          ),
      operationIds.length === 0
        ? Promise.resolve([])
        : db.query(
            `
              SELECT *
              FROM quota_materialization_attempt
              WHERE operation INSIDE $operations
              ORDER BY completed_at DESC
              LIMIT $limit;
            `,
            { operations: operationIds, limit: input.limit },
          ),
    ]);
    const intentStateByIntent = new Map(
      rows(intentStateResult).flatMap((row) => {
        const intent = toStringRecordId(row.intent);
        return intent ? [[intent.toString(), row] as const] : [];
      }),
    );

    const items: QuotaOpsTimelineItem[] = [];
    for (const row of intentRows) {
      const id = recordString(row.id, "intent id");
      const state = intentStateByIntent.get(id);
      items.push(timelineItem({
        id,
        kind: "operator_intent",
        label: requiredString(row.intent_kind, "intent kind"),
        state: optionalString(state?.state) ?? "pending",
        occurred_at:
          toIsoDateTimeString(state?.updated_at)
          ?? dateTime(row.created_at, "intent created_at"),
        actor_subject: optionalString(row.actor_subject),
        authorized_capability: capability(row.authorized_capability),
        request_id: optionalString(row.request_id),
        correlation_id: requiredString(
          row.correlation_id,
          "intent correlation_id",
        ),
        error_code: optionalString(state?.last_error_code),
      }));
    }
    for (const row of rows(entitlementResult)) {
      items.push(timelineItem({
        id: recordString(row.id, "entitlement operation id"),
        kind: "entitlement_operation",
        label: requiredString(row.operation_kind, "operation kind"),
        state: requiredString(row.outcome, "operation outcome"),
        occurred_at: dateTime(row.completed_at, "operation completed_at"),
        actor_subject: optionalString(row.actor_subject),
        authorized_capability: capability(row.authorized_capability),
        request_id: optionalString(row.request_id),
        correlation_id: requiredString(
          row.correlation_id,
          "operation correlation_id",
        ),
        error_code: optionalString(row.error_code),
      }));
    }
    for (const row of operationRows) {
      items.push(timelineItem({
        id: recordString(row.id, "materialization operation id"),
        kind: "materialization_operation",
        label: "quota_materialization",
        state: requiredString(row.status, "materialization status"),
        occurred_at: dateTime(row.updated_at, "materialization updated_at"),
        actor_subject: null,
        authorized_capability: null,
        request_id: optionalString(row.request_id),
        correlation_id: requiredString(
          row.correlation_id,
          "materialization correlation_id",
        ),
        error_code: optionalString(row.last_error_code),
      }));
    }
    for (const row of rows(attemptResult)) {
      items.push(timelineItem({
        id: recordString(row.id, "materialization attempt id"),
        kind: "materialization_attempt",
        label: `attempt ${String(row.attempt_number ?? "")}`.trim(),
        state: requiredString(row.outcome, "attempt outcome"),
        occurred_at: dateTime(row.completed_at, "attempt completed_at"),
        actor_subject: null,
        authorized_capability: null,
        request_id: null,
        correlation_id: requiredString(
          row.correlation_id,
          "attempt correlation_id",
        ),
        error_code: optionalString(row.error_code),
      }));
    }
    for (const row of rows(auditResult)) {
      items.push(timelineItem({
        id: recordString(row.id, "audit id"),
        kind: "audit",
        label: requiredString(row.event_kind, "audit event kind"),
        state: row.error_code ? "failed" : "recorded",
        occurred_at: dateTime(row.occurred_at, "audit occurred_at"),
        actor_subject: optionalString(row.actor_subject),
        authorized_capability: capability(row.authorized_capability),
        request_id: optionalString(row.request_id),
        correlation_id: requiredString(
          row.correlation_id,
          "audit correlation_id",
        ),
        error_code: optionalString(row.error_code),
      }));
    }
    items.sort((left, right) =>
      Date.parse(right.occurred_at) - Date.parse(left.occurred_at)
    );

    return {
      format_version: QUOTA_API_FORMAT_VERSION,
      workspace: {
        id: workspaceId.toString(),
        slug: requiredString(workspace.slug, "workspace slug"),
        name: requiredString(workspace.name, "workspace name"),
      },
      items: items.slice(0, input.limit),
    };
  }
}
