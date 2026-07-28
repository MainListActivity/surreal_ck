import type {
  ControlPlaneObject,
  NativeQuotaInfo,
  NativeQuotaLimit,
  NativeQuotaResource,
  QuotaCapacityState,
  QuotaCompliance,
} from "@surreal-ck/shared/native-quota";
import { DateTime, StringRecordId } from "surrealdb";
import { getRootDatabaseSession } from "../db/root-connection";
import { toStringRecordId } from "../db/surreal-values";
import { stableSha256 } from "./canonical";
import {
  evaluateQuotaAlerts,
  type QuotaAlertObservation,
  type QuotaAlertSnapshot,
  type QuotaAlertTransition,
} from "./quota-alerts";
import type {
  QuotaObservationSink,
  QuotaWorkspaceAuthority,
} from "./quota-read-service";
import { canonicalNativePolicyDigest } from "./policy-compiler";

const CACHE_TTL_MS = 15_000;

type Queryable = {
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

export type NativeUsageFact = Readonly<{
  resourceKey: string;
  resource: NativeQuotaResource;
  label: string;
  tableIdentity?: string;
  limit: NativeQuotaLimit;
  used: number | bigint;
}>;

export type QuotaRuntimeObservation = Readonly<{
  workspace: StringRecordId;
  observedAt: DateTime;
  auditedAt: DateTime;
  cacheExpiresAt: DateTime;
  nativeGeneration?: number | bigint;
  nativeDigest?: string;
  ledgerState: NativeQuotaInfo["ledger"]["state"];
  usageTrusted: boolean;
  usageSummary: ControlPlaneObject;
  compliance: QuotaCompliance;
  capacity: QuotaCapacityState;
  sync:
    | "pending"
    | "in_sync"
    | "external_drift"
    | "paused";
}>;

export type QuotaAlertRecipients = Readonly<{
  workspaceAdmins: readonly string[];
  billingAdmins: readonly string[];
  billingAccount?: StringRecordId;
}>;

export interface QuotaObservationStore {
  recordRuntime(observation: QuotaRuntimeObservation): Promise<void>;
  loadAlertSnapshots(input: Readonly<{
    workspace: StringRecordId;
    projection: StringRecordId;
  }>): Promise<readonly QuotaAlertSnapshot[]>;
  loadAlertRecipients(workspace: StringRecordId): Promise<QuotaAlertRecipients>;
  persistAlertTransitions(input: Readonly<{
    workspace: StringRecordId;
    projection: StringRecordId;
    transitions: readonly QuotaAlertTransition[];
    recipients: QuotaAlertRecipients;
    labels: ReadonlyMap<string, string>;
    observedAt: DateTime;
  }>): Promise<void>;
}

function surrealDateTimeFromMs(milliseconds: number): DateTime {
  return DateTime.fromEpochNanoseconds(BigInt(milliseconds) * 1_000_000n);
}

function nativeFacts(
  authority: QuotaWorkspaceAuthority,
  info: NativeQuotaInfo,
): NativeUsageFact[] {
  const projection = authority.appliedProjection;
  if (!projection || !info.usage) return [];
  const ruleById = new Map(projection.rules.map((rule) => [rule.rule_id, rule]));
  const facts: NativeUsageFact[] = [];
  const observedRuleIds = new Set<string>();

  for (const bucket of info.usage.table_buckets) {
    const rule = ruleById.get(bucket.rule_id);
    observedRuleIds.add(bucket.rule_id);
    facts.push({
      resourceKey: rule?.rule_key ?? `table/${bucket.rule_id}`,
      resource: "table",
      label: rule?.customer_label ?? "数据表",
      limit: bucket.limit,
      used: bucket.used,
    });
  }

  for (const table of info.usage.tables) {
    for (const resource of ["field", "record"] as const) {
      const usage = table[resource];
      for (const ruleId of usage.effective_rule_ids) {
        observedRuleIds.add(ruleId);
      }
      const effectiveRules = usage.effective_rule_ids
        .map((ruleId) => ruleById.get(ruleId))
        .filter((rule) => rule !== undefined);
      const keys = effectiveRules.map((rule) => rule.rule_key).sort();
      const labels = effectiveRules.map((rule) => rule.customer_label);
      facts.push({
        resourceKey:
          keys.length === 0
            ? `${resource}/unmatched`
            : keys.join("+"),
        resource,
        label:
          labels.length === 0
            ? resource === "field" ? "字段" : "记录"
            : labels.join(" + "),
        tableIdentity: table.table,
        limit: usage.limit,
        used: usage.used,
      });
    }
  }
  for (const rule of projection.rules) {
    if (observedRuleIds.has(rule.rule_id)) continue;
    facts.push({
      resourceKey: rule.rule_key,
      resource: rule.resource,
      label: rule.customer_label,
      ...(rule.selector.kind === "exact"
        ? { tableIdentity: rule.selector.table }
        : {}),
      limit: rule.limit,
      used: 0,
    });
  }
  return facts;
}

function ratioPercent(used: number | bigint, limit: number | bigint): number {
  const normalizedUsed = BigInt(used);
  const normalizedLimit = BigInt(limit);
  if (normalizedLimit === 0n) return normalizedUsed === 0n ? 100 : 101;
  return Number((normalizedUsed * 10_000n) / normalizedLimit) / 100;
}

function capacity(facts: readonly NativeUsageFact[], trusted: boolean): Readonly<{
  capacity: QuotaCapacityState;
  compliance: QuotaCompliance;
}> {
  if (!trusted) return { capacity: "unknown", compliance: "unknown" };
  const finite = facts.filter(
    (fact): fact is NativeUsageFact & {
      limit: Readonly<{ kind: "finite"; value: number | bigint }>;
    } => fact.limit.kind === "finite",
  );
  if (finite.some((fact) => BigInt(fact.used) > BigInt(fact.limit.value))) {
    return { capacity: "over_limit", compliance: "over_limit" };
  }
  if (finite.some((fact) => BigInt(fact.used) === BigInt(fact.limit.value))) {
    return { capacity: "at_limit", compliance: "compliant" };
  }
  const highest = finite.reduce(
    (current, fact) =>
      Math.max(current, ratioPercent(fact.used, fact.limit.value)),
    0,
  );
  if (highest >= 90) return { capacity: "critical", compliance: "compliant" };
  if (highest >= 80) return { capacity: "warning", compliance: "compliant" };
  return { capacity: "normal", compliance: "compliant" };
}

function alertObservations(
  facts: readonly NativeUsageFact[],
): QuotaAlertObservation[] {
  return facts.flatMap((fact) =>
    fact.limit.kind === "finite"
      ? [{
          resourceKey: fact.resourceKey,
          ...(fact.tableIdentity ? { tableIdentity: fact.tableIdentity } : {}),
          used: BigInt(fact.used),
          limit: BigInt(fact.limit.value),
        }]
      : []
  );
}

function syncState(
  authority: QuotaWorkspaceAuthority,
  nativeDigest?: string,
): QuotaRuntimeObservation["sync"] {
  if (
    !authority.runtime.autoReconcile
    || authority.runtime.sync === "paused"
  ) {
    return "paused";
  }
  if (
    authority.appliedProjection
    && nativeDigest !== authority.appliedProjection.canonicalDigest
  ) {
    return "external_drift";
  }
  if (
    authority.desiredProjection?.record
    && authority.appliedProjection?.record
    && authority.desiredProjection.record !== authority.appliedProjection.record
  ) {
    return "pending";
  }
  return "in_sync";
}

export class QuotaObservationService implements QuotaObservationSink {
  constructor(
    private readonly store: QuotaObservationStore,
    private readonly now: () => number = Date.now,
  ) {}

  async observe(input: Readonly<{
    authority: QuotaWorkspaceAuthority;
    info: NativeQuotaInfo;
  }>): Promise<void> {
    const workspace = new StringRecordId(input.authority.workspace.record);
    const observedAt = new DateTime(input.info.observed_at);
    const auditedAt = surrealDateTimeFromMs(this.now());
    const facts = nativeFacts(input.authority, input.info);
    const trusted = input.info.ledger.usage_trusted && input.info.usage !== null;
    const state = capacity(facts, trusted);
    const nativeDigest = input.info.policy
      ? canonicalNativePolicyDigest(input.info.policy.rules)
      : undefined;

    await this.store.recordRuntime({
      workspace,
      observedAt,
      auditedAt,
      cacheExpiresAt: surrealDateTimeFromMs(this.now() + CACHE_TTL_MS),
      ...(input.info.policy
        ? { nativeGeneration: input.info.policy.generation }
        : {}),
      ...(nativeDigest ? { nativeDigest } : {}),
      ledgerState: input.info.ledger.state,
      usageTrusted: trusted,
      usageSummary: {
        format_version: 1,
        facts: facts.map((fact) => ({
          resource_key: fact.resourceKey,
          resource: fact.resource,
          table_identity: fact.tableIdentity,
          label: fact.label,
          limit: fact.limit,
          used: fact.used,
        })),
      },
      compliance: state.compliance,
      capacity: state.capacity,
      sync: syncState(input.authority, nativeDigest),
    });

    if (!trusted || !input.authority.appliedProjection) return;
    const projection = new StringRecordId(
      input.authority.appliedProjection.record,
    );
    const previous = await this.store.loadAlertSnapshots({
      workspace,
      projection,
    });
    const transitions = evaluateQuotaAlerts({
      projection: projection.toString(),
      observations: alertObservations(facts),
      previous,
    });
    if (transitions.length === 0) return;
    await this.store.persistAlertTransitions({
      workspace,
      projection,
      transitions,
      recipients: await this.store.loadAlertRecipients(workspace),
      labels: new Map(facts.map((fact) => [fact.resourceKey, fact.label])),
      observedAt,
    });
  }
}

function rows(result: unknown): Record<string, unknown>[] {
  const statement = Array.isArray(result) ? result[0] : undefined;
  return Array.isArray(statement)
    ? statement.filter(
        (row): row is Record<string, unknown> =>
          typeof row === "object" && row !== null,
      )
    : [];
}

function values(result: unknown): unknown[] {
  const statement = Array.isArray(result) ? result[0] : undefined;
  return Array.isArray(statement) ? statement : [];
}

function alertSnapshot(row: Record<string, unknown>): QuotaAlertSnapshot | null {
  const projection = toStringRecordId(row.applied_projection);
  if (!projection) return null;
  const resourceKey = row.resource_key;
  const threshold = row.threshold_percent;
  const episode = row.episode;
  const used = row.used;
  const limit = row.limit;
  const ratio = row.last_ratio_percent;
  if (
    typeof resourceKey !== "string"
    || (threshold !== 80 && threshold !== 90 && threshold !== 100)
    || typeof episode !== "number"
    || !Number.isSafeInteger(episode)
    || (typeof used !== "number" && typeof used !== "bigint")
    || (typeof limit !== "number" && typeof limit !== "bigint")
    || typeof ratio !== "number"
  ) {
    return null;
  }
  return {
    projection: projection.toString(),
    kind: row.alert_kind === "over_limit" ? "over_limit" : "threshold",
    resourceKey,
    ...(typeof row.table_identity === "string"
      ? { tableIdentity: row.table_identity }
      : {}),
    threshold,
    episode,
    state: row.state === "notified" ? "notified" : "cleared",
    used: BigInt(used),
    limit: BigInt(limit),
    ratioPercent: ratio,
  };
}

function latestAlertSnapshots(
  input: readonly QuotaAlertSnapshot[],
): QuotaAlertSnapshot[] {
  const latest = new Map<string, QuotaAlertSnapshot>();
  for (const snapshot of input) {
    const key = [
      snapshot.projection,
      snapshot.kind,
      snapshot.resourceKey,
      snapshot.tableIdentity ?? "",
      snapshot.threshold,
    ].join("\0");
    const current = latest.get(key);
    if (!current || snapshot.episode > current.episode) latest.set(key, snapshot);
  }
  return [...latest.values()];
}

export class SurrealQuotaObservationStore implements QuotaObservationStore {
  private readonly getDb: () => Promise<Queryable>;

  constructor(options: Readonly<{
    db?: Queryable;
    getDb?: () => Promise<Queryable>;
  }> = {}) {
    this.getDb = options.db
      ? async () => options.db!
      : options.getDb ?? (() => getRootDatabaseSession("_system"));
  }

  async recordRuntime(observation: QuotaRuntimeObservation): Promise<void> {
    const db = await this.getDb();
    await db.query(
      `
        UPDATE workspace_quota_runtime
        MERGE $patch
        WHERE workspace = $workspace;
      `,
      {
        workspace: observation.workspace,
        patch: {
          sync_state: observation.sync,
          quota_compliance: observation.compliance,
          capacity_state: observation.capacity,
          last_native_audit_at: observation.auditedAt,
          native_observed_at: observation.observedAt,
          native_observed_generation: observation.nativeGeneration,
          native_observed_digest: observation.nativeDigest,
          ledger_state: observation.ledgerState,
          usage_trusted: observation.usageTrusted,
          usage_summary: observation.usageSummary,
          cache_expires_at: observation.cacheExpiresAt,
        },
      },
    );
  }

  async loadAlertSnapshots(input: Readonly<{
    workspace: StringRecordId;
    projection: StringRecordId;
  }>): Promise<readonly QuotaAlertSnapshot[]> {
    const db = await this.getDb();
    const result = await db.query(
      `
        SELECT
          applied_projection,
          alert_kind,
          resource_key,
          table_identity,
          threshold_percent,
          episode,
          state,
          used,
          limit,
          last_ratio_percent
        FROM quota_alert_state
        WHERE workspace = $workspace
          AND applied_projection = $projection
        ORDER BY episode DESC;
      `,
      input,
    );
    return latestAlertSnapshots(
      rows(result).flatMap((row) => {
        const parsed = alertSnapshot(row);
        return parsed ? [parsed] : [];
      }),
    );
  }

  async loadAlertRecipients(workspace: StringRecordId): Promise<QuotaAlertRecipients> {
    const db = await this.getDb();
    const [workspaceAdminsResult, billingAccountResult] = await Promise.all([
      db.query(
        `
          SELECT VALUE subject
          FROM user_workspace_index
          WHERE workspace = $workspace
            AND role = "admin"
            AND disabled_at = NONE
            AND subject != NONE;
        `,
        { workspace },
      ),
      db.query(
        `
          SELECT VALUE billing_account
          FROM quota_subscription
          WHERE id IN (
            SELECT VALUE subscription
            FROM quota_subscription_item
            WHERE workspace = $workspace
            ORDER BY effective_from DESC
            LIMIT 1
          )
          LIMIT 1;
        `,
        { workspace },
      ),
    ]);
    const billingAccount = values(billingAccountResult)
      .map(toStringRecordId)
      .find((record) => record !== null) ?? undefined;
    const billingAdminsResult = billingAccount
      ? await db.query(
          `
            SELECT VALUE subject
            FROM billing_account_member
            WHERE billing_account = $billing_account
              AND role INSIDE ["owner", "admin"]
              AND status = "active";
          `,
          { billing_account: billingAccount },
        )
      : [];
    const subjects = (result: unknown) =>
      values(result).filter(
        (subject): subject is string =>
          typeof subject === "string" && subject.length > 0,
      );
    return {
      workspaceAdmins: [...new Set(subjects(workspaceAdminsResult))],
      billingAdmins: [...new Set(subjects(billingAdminsResult))],
      ...(billingAccount ? { billingAccount } : {}),
    };
  }

  async persistAlertTransitions(input: Readonly<{
    workspace: StringRecordId;
    projection: StringRecordId;
    transitions: readonly QuotaAlertTransition[];
    recipients: QuotaAlertRecipients;
    labels: ReadonlyMap<string, string>;
    observedAt: DateTime;
  }>): Promise<void> {
    const db = await this.getDb();
    for (const transition of input.transitions) {
      const stateId = new StringRecordId(
        `quota_alert_state:${stableSha256(transition.dedupeKey)}`,
      );
      await db.query(
        `
          UPSERT $state
          MERGE $patch;
        `,
        {
          state: stateId,
          patch: {
            workspace: input.workspace,
            applied_projection: input.projection,
            alert_kind: transition.snapshot.kind,
            resource_key: transition.snapshot.resourceKey,
            ...(transition.snapshot.tableIdentity
              ? { table_identity: transition.snapshot.tableIdentity }
              : {}),
            threshold_percent: transition.snapshot.threshold,
            episode: transition.snapshot.episode,
            dedupe_key: transition.dedupeKey,
            state: transition.snapshot.state,
            used: transition.snapshot.used,
            limit: transition.snapshot.limit,
            last_ratio_percent: transition.snapshot.ratioPercent,
            last_observed_at: input.observedAt,
            ...(transition.action === "notify"
              ? {
                  first_observed_at: input.observedAt,
                  notified_at: input.observedAt,
                }
              : {}),
            ...(transition.action === "clear"
              ? { rearmed_at: input.observedAt }
              : {}),
          },
        },
      );
      if (transition.action !== "notify") continue;

      const workspaceSubjects = new Set(input.recipients.workspaceAdmins);
      const audiences = [
        ...input.recipients.workspaceAdmins.map((subject) => ({
          audience: "workspace_admin" as const,
          subject,
          revealTable: true,
        })),
        ...(transition.snapshot.threshold >= 90
          ? input.recipients.billingAdmins
              .filter((subject) => !workspaceSubjects.has(subject))
              .map((subject) => ({
                audience: "billing_admin" as const,
                subject,
                revealTable: false,
              }))
          : []),
      ];
      for (const audience of audiences) {
        const notificationDedupe = [
          transition.dedupeKey,
          audience.audience,
          audience.subject,
        ].join(":");
        const notification = new StringRecordId(
          `quota_notification_outbox:${stableSha256(notificationDedupe)}`,
        );
        const delivery = new StringRecordId(
          `quota_notification_delivery:${stableSha256(notificationDedupe)}`,
        );
        await db.query(
          `
            BEGIN TRANSACTION;
            IF !record::exists($notification) {
              CREATE $notification CONTENT $notification_content;
              CREATE $delivery CONTENT $delivery_content;
            };
            COMMIT TRANSACTION;
          `,
          {
            notification,
            delivery,
            notification_content: {
              workspace: input.workspace,
              billing_account: input.recipients.billingAccount,
              alert_state: stateId,
              audience: audience.audience,
              recipient_subject: audience.subject,
              channel: "in_app",
              dedupe_key: notificationDedupe,
              payload: {
                format_version: 1,
                kind: transition.snapshot.kind,
                threshold_percent: transition.snapshot.threshold,
                resource_key: transition.snapshot.resourceKey,
                label:
                  input.labels.get(transition.snapshot.resourceKey) ?? "资源配额",
                table_identity: audience.revealTable
                  ? transition.snapshot.tableIdentity
                  : undefined,
                used: transition.snapshot.used,
                limit: transition.snapshot.limit,
              },
              correlation_id: `quota-alert:${transition.dedupeKey}`,
              causation_id: transition.dedupeKey,
              created_at: input.observedAt,
            },
            delivery_content: {
              notification,
              status: "pending",
              attempt_count: 0,
            },
          },
        );
      }
    }
  }
}
