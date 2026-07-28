import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, jsonify, StringRecordId, Surreal } from "surrealdb";
import { seedQuotaPlans } from "../db/quota-plan-seed";
import { SurrealQuotaControlPlaneStore } from "./control-plane-store";
import { SurrealEntitlementRefreshService } from "./entitlement-refresh";
import { SurrealLifecycleBoundarySweepHandler } from "./lifecycle-sweep";
import { SurrealQuotaLifecycleStore } from "./lifecycle-store";
import {
  operatorIntentDigest,
  type OperatorIntentSubmission,
  type ProviderSubscriptionEventInput,
} from "./subscription-lifecycle";
import { SurrealQuotaAuthorityReader } from "./quota-authority-reader";
import { SurrealQuotaObservationStore } from "./quota-observation";
import { SurrealQuotaNotificationService } from "./quota-notifications";

const RUN_INTEGRATION =
  process.env.RUN_LOCAL_SURREALDB_QUOTA_LIFECYCLE_TESTS === "1";
const localTest = test.skipIf(!RUN_INTEGRATION);
const surrealBinary = process.env.SURREAL_BINARY ?? "surreal";
const namespace = "main";
const database = "_system";
const migrationsUrl = new URL(
  "../../../shared/sql/system/",
  import.meta.url,
);

let endpoint = "";
let workingDirectory = "";
let server: ReturnType<typeof Bun.spawn> | undefined;
let db: Surreal | undefined;

function id(value: string): StringRecordId {
  return new StringRecordId(value);
}

async function allocatePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close();
        reject(new Error("failed to allocate SurrealDB port"));
        return;
      }
      listener.close((error) =>
        error ? reject(error) : resolve(address.port)
      );
    });
  });
}

async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const probe = Bun.spawn([
      surrealBinary,
      "is-ready",
      "--endpoint",
      endpoint,
    ], { stdout: "ignore", stderr: "ignore" });
    if (await probe.exited === 0) return;
    await Bun.sleep(100);
  }
  throw new Error("local SurrealDB did not become ready");
}

function queryClient() {
  if (!db) throw new Error("integration database not initialized");
  return {
    query: async <T = unknown>(
      sql: string,
      params?: Record<string, unknown>,
    ): Promise<T> => await db!.query(sql, params) as T,
  };
}

function rows(result: unknown, statement = 0): Record<string, unknown>[] {
  const value = Array.isArray(result) ? result[statement] : undefined;
  const normalized = jsonify(value);
  if (Array.isArray(normalized)) {
    return normalized as Record<string, unknown>[];
  }
  return typeof normalized === "object" && normalized !== null
    ? [normalized as Record<string, unknown>]
    : [];
}

beforeAll(async () => {
  if (!RUN_INTEGRATION) return;
  workingDirectory = await mkdtemp(
    join(tmpdir(), "surreal-ck-quota-lifecycle-"),
  );
  const port = await allocatePort();
  endpoint = `ws://127.0.0.1:${port}`;
  server = Bun.spawn([
    surrealBinary,
    "start",
    "--no-banner",
    "--log",
    "none",
    "--bind",
    `127.0.0.1:${port}`,
    "--user",
    "root",
    "--pass",
    "root",
    "memory",
  ], {
    cwd: workingDirectory,
    stdout: "ignore",
    stderr: "pipe",
  });
  await waitUntilReady();

  db = new Surreal();
  await db.connect(`${endpoint}/rpc`, {
    authentication: { username: "root", password: "root" },
  });
  await db.query(`DEFINE NAMESPACE IF NOT EXISTS ${namespace};`);
  await db.use({ namespace });
  await db.query(`DEFINE DATABASE IF NOT EXISTS ${database};`);
  await db.query("DEFINE DATABASE IF NOT EXISTS ws_acme;");
  await db.use({ namespace, database });
  const migrations = (await readdir(migrationsUrl))
    .filter((entry) => /^\d{3}-.+\.surql$/u.test(entry))
    .sort();
  for (const migration of migrations) {
    await db.query(await readFile(new URL(migration, migrationsUrl), "utf8"));
  }
  await seedQuotaPlans({
    namespace,
    createdBySubject: "system:test",
    getDbSession: async () => queryClient(),
  });
  await db.query(`
    CREATE workspace:acme CONTENT {
      db_name: "ws_acme",
      owner_subject: "operator:alice",
      slug: "acme",
      name: "Acme",
      status: "active"
    };
    CREATE billing_account:acme CONTENT {
      account_key: "acme",
      name: "Acme Billing",
      kind: "team",
      status: "active"
    };
    CREATE billing_account:beta CONTENT {
      account_key: "beta",
      name: "Beta Billing",
      kind: "team",
      status: "active"
    };
    CREATE billing_account_member:alice CONTENT {
      billing_account: billing_account:acme,
      subject: "operator:alice",
      role: "owner",
      status: "active"
    };
    CREATE user_workspace_index:alice CONTENT {
      subject: "operator:alice",
      workspace: workspace:acme,
      db_name: "ws_acme",
      role: "admin"
    };
    CREATE platform_operator:alice CONTENT {
      subject: "operator:alice",
      display_name: "Alice",
      status: "active"
    };
    CREATE platform_operator_capability:alice_subscription CONTENT {
      operator: platform_operator:alice,
      capability: "subscription.manage",
      status: "active",
      granted_by_subject: "system:test"
    };
  `);
});

afterAll(async () => {
  await db?.close();
  server?.kill();
  if (server) await server.exited;
  if (workingDirectory) {
    await rm(workingDirectory, { force: true, recursive: true });
  }
});

function manualAssignment(
  requestId: string,
  effectiveAt: DateTime,
): OperatorIntentSubmission {
  return {
    kind: "subscription_upsert",
    actorSubject: "operator:alice",
    actorCapability: "subscription.manage",
    requestId,
    workspace: id("workspace:acme"),
    billingAccount: id("billing_account:acme"),
    customerReason: "客户确认订阅 Plus",
    operatorReason: "手工付款记录已复核",
    effectiveAt,
    input: {
      mode: "manual_assignment",
      workspace: id("workspace:acme"),
      billing_account: id("billing_account:acme"),
      plan_revision: id("quota_plan_revision:plus_v1"),
      source: "manual",
      status: "active",
    },
    impactPreview: {
      desired_plan: "plus",
      applies_after_native_readback: true,
    },
    correlationId: `corr-${requestId}`,
  };
}

function providerEvent(
  eventId: string,
  revision: number,
  status: "active" | "past_due",
): ProviderSubscriptionEventInput {
  return {
    provider: "stripe",
    eventId,
    eventType: "customer.subscription.updated",
    providerObjectId: "sub_provider_1",
    payloadDigest: `digest-${eventId}`,
    safePayload: { object_kind: "subscription" },
    signatureVerifiedAt: new DateTime("2026-08-01T00:00:00.000Z"),
    correlationId: `corr-${eventId}`,
    snapshot: {
      billingAccount: id("billing_account:acme"),
      providerCustomerId: "cus_acme",
      providerSubscriptionId: "sub_provider_1",
      sourceRevision: revision,
      status,
      currentPeriodEnd: new DateTime("2026-09-01T00:00:00.000Z"),
      graceUntil: status === "past_due"
        ? new DateTime("2026-08-08T00:00:00.000Z")
        : undefined,
      cancelAtPeriodEnd: false,
    },
  };
}

describe("quota subscription lifecycle against local SurrealDB", () => {
  localTest(
    "persists scheduled intent, isolates capabilities, materializes before applied mode, and rejects provider rollback",
    async () => {
      const client = queryClient();
      const store = new SurrealQuotaLifecycleStore(client);
      const effectiveAt = new DateTime("2026-08-01T00:00:10.000Z");
      const submission = manualAssignment("manual-plus-1", effectiveAt);
      const persisted = await store.persistOperatorIntent({
        ...submission,
        requiredCapability: "subscription.manage",
        inputDigest: operatorIntentDigest(submission),
        now: new DateTime("2026-08-01T00:00:00.000Z"),
      });
      expect(persisted.kind).toBe("accepted");
      await expect(store.persistOperatorIntent({
        ...submission,
        requiredCapability: "subscription.manage",
        inputDigest: operatorIntentDigest(submission),
        now: new DateTime("2026-08-01T00:00:01.000Z"),
      })).resolves.toMatchObject({ kind: "duplicate" });
      await expect(store.claimOperatorIntent({
        workerId: "worker-a",
        now: new DateTime("2026-08-01T00:00:09.999Z"),
        leaseDurationMs: 1_000,
      })).resolves.toBeUndefined();

      await expect(store.persistOperatorIntent({
        ...submission,
        kind: "override_schedule",
        actorCapability: "override.manage",
        requestId: "forbidden-override",
        input: {
          workspace: id("workspace:acme"),
          patches: [],
        },
        requiredCapability: "override.manage",
        inputDigest: "forbidden",
        now: new DateTime("2026-08-01T00:00:00.000Z"),
      })).rejects.toThrow();

      const claim = await store.claimOperatorIntent({
        workerId: "worker-a",
        now: effectiveAt,
        leaseDurationMs: 10_000,
      });
      expect(claim?.kind).toBe("subscription_upsert");
      if (!claim) throw new Error("expected due operator intent");
      const mutation = await store.applyOperatorMutation(claim);
      expect(mutation.workspaces.map(String)).toEqual(["workspace:acme"]);
      expect(await store.settleOperatorIntent(
        claim,
        {},
        new DateTime("2026-08-01T00:00:10.001Z"),
      )).toBeTrue();

      const beforeRefresh = await db!.query(
        "SELECT desired_entitlement, applied_entitlement FROM ONLY workspace:acme;",
      );
      expect(rows(beforeRefresh)[0]?.desired_entitlement).toBeUndefined();
      expect(rows(beforeRefresh)[0]?.applied_entitlement).toBeUndefined();

      const refresher = new SurrealEntitlementRefreshService(client);
      const refreshed = await refresher.refreshWorkspace({
        workspace: id("workspace:acme"),
        at: effectiveAt,
        operationKind: "manual_assignment",
        actorKind: "operator",
        actorSubject: "operator:alice",
        authorizedCapability: "subscription.manage",
        requestId: "manual-plus-1",
        correlationId: "corr-manual-plus-1",
        causationId: claim.intent.toString(),
      });
      expect(refreshed.materializationOperation).toBeDefined();
      const pending = await db!.query(
        `
          SELECT desired_entitlement, applied_entitlement
          FROM ONLY workspace:acme;
          SELECT service_mode, sync_state
          FROM workspace_quota_runtime
          WHERE workspace = workspace:acme;
        `,
      );
      expect(rows(pending, 0)[0]?.desired_entitlement).toBeDefined();
      expect(rows(pending, 0)[0]?.applied_entitlement).toBeUndefined();
      expect(rows(pending, 1)[0]).toMatchObject({
        service_mode: "retention",
        sync_state: "pending",
      });

      const controlStore = new SurrealQuotaControlPlaneStore(client);
      const materialization = await controlStore.claimNextMaterialization({
        workerId: "materializer-a",
        now: new DateTime("2026-08-01T00:00:11.000Z"),
        leaseDurationMs: 30_000,
      });
      expect(materialization?.serviceMode).toBe("standard");
      if (!materialization) throw new Error("expected materialization");
      await expect(controlStore.settleMaterialization(materialization, {
        kind: "succeeded",
        outcome: "succeeded",
        completedAt: new DateTime("2026-08-01T00:00:12.000Z"),
        observedAfterGeneration: 1,
        observedAfterDigest: materialization.projection.canonical_digest,
        ledgerState: "ready",
        usageTrusted: true,
      })).resolves.toBe("committed");
      const applied = await db!.query(
        `
          SELECT desired_entitlement, applied_entitlement
          FROM ONLY workspace:acme;
          SELECT service_mode, sync_state
          FROM workspace_quota_runtime
          WHERE workspace = workspace:acme;
        `,
      );
      expect(rows(applied, 0)[0]?.applied_entitlement).toEqual(
        rows(applied, 0)[0]?.desired_entitlement,
      );
      expect(rows(applied, 1)[0]).toMatchObject({
        service_mode: "standard",
        sync_state: "in_sync",
      });

      const authorityReader = new SurrealQuotaAuthorityReader({ db: client });
      const authority = await authorityReader.findWorkspaceAuthority({
        slug: "acme",
        actor: { subject: "operator:alice" },
      });
      expect(authority).toMatchObject({
        workspace: { record: "workspace:acme", database: "ws_acme" },
        workspaceRole: "admin",
        billingRole: "owner",
        appliedEntitlement: { planKey: "plus" },
      });
      await expect(authorityReader.findBillingAuthority({
        accountKey: "acme",
        actor: { subject: "operator:alice" },
      })).resolves.toMatchObject({
        account: { accountKey: "acme" },
        workspaces: [{ workspace: { record: "workspace:acme" } }],
      });
      await expect(authorityReader.findBillingAuthority({
        accountKey: "beta",
        actor: { subject: "operator:alice" },
      })).resolves.toBeNull();

      const observationStore = new SurrealQuotaObservationStore({ db: client });
      const recipients = await observationStore.loadAlertRecipients(
        id("workspace:acme"),
      );
      expect(recipients).toMatchObject({
        workspaceAdmins: ["operator:alice"],
        billingAdmins: ["operator:alice"],
      });
      const alertObservedAt = new DateTime(
        "2026-08-01T00:00:13.000Z",
      );
      await observationStore.persistAlertTransitions({
        workspace: id("workspace:acme"),
        projection: materialization.projection.id,
        transitions: [{
          action: "notify",
          dedupeKey: "workspace:acme:record/ent:ent_case:90:1",
          snapshot: {
            projection: materialization.projection.id.toString(),
            kind: "threshold",
            resourceKey: "record/ent",
            tableIdentity: "ent_case",
            threshold: 90,
            episode: 1,
            state: "notified",
            used: 90n,
            limit: 100n,
            ratioPercent: 90,
          },
        }],
        recipients,
        labels: new Map([["record/ent", "实体记录"]]),
        observedAt: alertObservedAt,
      });
      const alertSnapshots = await observationStore.loadAlertSnapshots({
        workspace: id("workspace:acme"),
        projection: materialization.projection.id,
      });
      expect(alertSnapshots).toHaveLength(1);
      expect(alertSnapshots[0]).toMatchObject({
        kind: "threshold",
        threshold: 90,
        episode: 1,
      });

      const notifications = new SurrealQuotaNotificationService({
        db: client,
      });
      const inApp = await notifications.list({
        actorSubject: "operator:alice",
        limit: 10,
      });
      expect(inApp).toHaveLength(1);
      expect(inApp[0]).toMatchObject({
        workspace: { id: "workspace:acme" },
        threshold_percent: 90,
        table: "ent_case",
        read_at: null,
      });
      expect(await notifications.markRead({
        notification: id(inApp[0]!.id),
        actorSubject: "operator:alice",
      })).toBeTrue();
      expect((await notifications.list({
        actorSubject: "operator:alice",
        limit: 10,
      }))[0]?.read_at).not.toBeNull();

      const processIntent = async (
        submissionInput: OperatorIntentSubmission,
      ) => {
        await store.persistOperatorIntent({
          ...submissionInput,
          requiredCapability: submissionInput.actorCapability,
          inputDigest: operatorIntentDigest(submissionInput),
          now: submissionInput.effectiveAt,
        });
        const next = await store.claimOperatorIntent({
          workerId: "worker-a",
          now: submissionInput.effectiveAt,
          leaseDurationMs: 10_000,
        });
        if (!next) throw new Error("expected operator intent");
        const appliedMutation = await store.applyOperatorMutation(next);
        let refreshResult = {};
        for (const workspace of appliedMutation.workspaces) {
          refreshResult = await refresher.refreshWorkspace({
            workspace,
            at: next.effectiveAt,
            operationKind:
              next.kind === "override_schedule" ? "override_change"
              : next.input.mode === "plan_rollout"
                || next.input.mode === "payer_switch"
              ? "plan_rollout"
              : "manual_assignment",
            actorKind: "operator",
            actorSubject: next.actorSubject,
            authorizedCapability: next.authorizedCapability,
            requestId: next.requestId,
            correlationId: next.correlationId,
            causationId: next.intent.toString(),
          });
        }
        expect(await store.settleOperatorIntent(
          next,
          refreshResult,
          submissionInput.effectiveAt,
        )).toBeTrue();
        return appliedMutation;
      };

      const rolloutAt = new DateTime("2026-08-03T00:00:00.000Z");
      await processIntent({
        kind: "subscription_upsert",
        actorSubject: "operator:alice",
        actorCapability: "subscription.manage",
        requestId: "rollout-pro-v1",
        workspace: id("workspace:acme"),
        billingAccount: id("billing_account:acme"),
        customerReason: "Plus 套餐统一升级",
        operatorReason: "发布 Pro revision 1",
        effectiveAt: rolloutAt,
        input: {
          mode: "plan_rollout",
          workspace: id("workspace:acme"),
          billing_account: id("billing_account:acme"),
          plan_revision: id("quota_plan_revision:pro_v1"),
          status: "active",
        },
        impactPreview: { from: "plus_v1", to: "pro_v1" },
        correlationId: "corr-rollout-pro-v1",
      });
      const rolledOut = await db!.query(
        `
          SELECT subscription, plan_revision
          FROM quota_subscription_item
          WHERE active_workspace = workspace:acme;
        `,
      );
      expect(rows(rolledOut)[0]?.plan_revision).toBe(
        "quota_plan_revision:pro_v1",
      );
      const rolledOutSubscription = rows(rolledOut)[0]?.subscription;
      if (typeof rolledOutSubscription === "string") {
        const lifecycle = await db!.query(
          "SELECT revision, status FROM ONLY $subscription;",
          { subscription: id(rolledOutSubscription) },
        );
        expect(rows(lifecycle)[0]).toMatchObject({
          revision: 1,
          status: "active",
        });
      }

      const payerSwitchAt = new DateTime("2026-08-04T00:00:00.000Z");
      await processIntent({
        kind: "subscription_upsert",
        actorSubject: "operator:alice",
        actorCapability: "subscription.manage",
        requestId: "payer-switch-beta",
        workspace: id("workspace:acme"),
        billingAccount: id("billing_account:beta"),
        customerReason: "客户指定新的付款主体",
        operatorReason: "付款主体授权材料已复核",
        effectiveAt: payerSwitchAt,
        input: {
          mode: "payer_switch",
          workspace: id("workspace:acme"),
          billing_account: id("billing_account:beta"),
          plan_revision: id("quota_plan_revision:max_v1"),
          source: "manual",
          status: "active",
        },
        impactPreview: { payer: "beta", plan: "max_v1" },
        correlationId: "corr-payer-switch-beta",
      });
      const switched = await db!.query(
        `
          LET $item = (
            SELECT *
            FROM quota_subscription_item
            WHERE active_workspace = workspace:acme
            LIMIT 1
          )[0];
          SELECT billing_account
          FROM ONLY $item.subscription;
        `,
      );
      expect(rows(switched, 1)[0]?.billing_account).toBe(
        "billing_account:beta",
      );

      await db!.query(`
        CREATE platform_operator_capability:alice_override CONTENT {
          operator: platform_operator:alice,
          capability: "override.manage",
          status: "active",
          granted_by_subject: "system:test"
        };
      `);
      const overrideAt = new DateTime("2026-08-05T00:00:00.000Z");
      await processIntent({
        kind: "override_schedule",
        actorSubject: "operator:alice",
        actorCapability: "override.manage",
        requestId: "override-records-1",
        workspace: id("workspace:acme"),
        customerReason: "临时活动需要额外记录容量",
        operatorReason: "批准七天临时容量",
        effectiveAt: overrideAt,
        input: {
          workspace: id("workspace:acme"),
          patches: [{
            rule_key: "entity-records",
            action: "replace",
            limit: { kind: "finite", value: 9 },
          }],
          expires_at: new DateTime("2026-08-12T00:00:00.000Z"),
        },
        impactPreview: { records: { before: 6, after: 9 } },
        correlationId: "corr-override-records-1",
      });
      const override = await db!.query(
        `
          LET $assignment = (
            SELECT *
            FROM workspace_quota_override
            WHERE workspace = workspace:acme
            LIMIT 1
          )[0];
          SELECT revision, request_id
          FROM ONLY $assignment.active_revision;
        `,
      );
      expect(rows(override, 1)[0]).toMatchObject({
        revision: 1,
        request_id: "override-records-1",
      });

      const revisionTwo = providerEvent("provider-revision-2", 2, "active");
      await expect(store.ingestProviderEvent(revisionTwo)).resolves.toMatchObject({
        kind: "accepted",
      });
      await expect(store.ingestProviderEvent(revisionTwo)).resolves.toMatchObject({
        kind: "duplicate",
      });
      const claimTwo = await store.claimProviderEvent({
        workerId: "provider-a",
        now: new DateTime("2026-08-02T00:00:00.000Z"),
        leaseDurationMs: 10_000,
      });
      if (!claimTwo) throw new Error("expected provider revision 2");
      const appliedTwo = await store.applyProviderSnapshot(claimTwo);
      expect(appliedTwo.kind).toBe("applied");
      expect(await store.settleProviderEvent(
        claimTwo,
        appliedTwo,
        new DateTime("2026-08-02T00:00:00.001Z"),
      )).toBeTrue();

      await store.ingestProviderEvent(
        providerEvent("provider-revision-1", 1, "past_due"),
      );
      const claimOne = await store.claimProviderEvent({
        workerId: "provider-a",
        now: new DateTime("2026-08-02T00:00:01.000Z"),
        leaseDurationMs: 10_000,
      });
      if (!claimOne) throw new Error("expected provider revision 1");
      const stale = await store.applyProviderSnapshot(claimOne);
      expect(stale.kind).toBe("stale_ignored");
      const providerSubscription = await db!.query(
        `
          SELECT provider_source_revision, status
          FROM quota_subscription
          WHERE provider = "stripe"
            AND provider_subscription_id = "sub_provider_1";
        `,
      );
      expect(rows(providerSubscription)[0]).toMatchObject({
        provider_source_revision: 2,
        status: "active",
      });

      await db!.query(`
        LET $item = (
          SELECT *
          FROM quota_subscription_item
          WHERE active_workspace = workspace:acme
          LIMIT 1
        )[0];
        UPDATE $item.subscription SET
          status = "past_due",
          grace_until = d"2026-08-13T00:00:00.000Z";
      `);
      const boundary = new SurrealLifecycleBoundarySweepHandler(
        client,
        refresher,
        {
          now: () => new DateTime("2026-08-13T00:00:00.000Z"),
        },
      );
      await expect(boundary.processPage({
        limit: 100,
        fencingToken: 99,
      })).resolves.toMatchObject({
        completed: true,
        processed: 1,
        failed: 0,
      });
      const retention = await db!.query(
        `
          LET $workspace = SELECT * FROM ONLY workspace:acme;
          SELECT service_mode
          FROM ONLY $workspace.desired_entitlement;
        `,
      );
      expect(rows(retention, 1)[0]?.service_mode).toBe("retention");
      await expect(boundary.processPage({
        limit: 100,
        fencingToken: 100,
      })).resolves.toMatchObject({
        completed: true,
        processed: 0,
        failed: 0,
      });

      const activeItem = await db!.query(
        `
          SELECT subscription
          FROM quota_subscription_item
          WHERE active_workspace = workspace:acme;
        `,
      );
      const activeSubscription = rows(activeItem)[0]?.subscription;
      if (typeof activeSubscription !== "string") {
        throw new Error("expected active subscription");
      }
      const endAt = new DateTime("2026-08-14T00:00:00.000Z");
      const endSubmission: OperatorIntentSubmission = {
        kind: "subscription_end",
        actorSubject: "operator:alice",
        actorCapability: "subscription.manage",
        requestId: "end-after-crash",
        workspace: id("workspace:acme"),
        billingAccount: id("billing_account:beta"),
        customerReason: "客户终止手工订阅",
        operatorReason: "终止材料已复核",
        effectiveAt: endAt,
        input: {
          subscription: id(activeSubscription),
          status: "canceled",
        },
        impactPreview: { service_mode: "retention" },
        correlationId: "corr-end-after-crash",
      };
      await store.persistOperatorIntent({
        ...endSubmission,
        requiredCapability: "subscription.manage",
        inputDigest: operatorIntentDigest(endSubmission),
        now: endAt,
      });
      const firstEndClaim = await store.claimOperatorIntent({
        workerId: "crashed-worker",
        now: endAt,
        leaseDurationMs: 1,
      });
      if (!firstEndClaim) throw new Error("expected first end claim");
      const firstEnd = await store.applyOperatorMutation(firstEndClaim);
      expect(firstEnd.workspaces.map(String)).toEqual(["workspace:acme"]);
      const revisionAfterFirst = rows(await db!.query(
        "SELECT revision FROM ONLY $subscription;",
        { subscription: id(activeSubscription) },
      ))[0]?.revision;

      const replayClaim = await store.claimOperatorIntent({
        workerId: "restarted-worker",
        now: new DateTime("2026-08-14T00:00:00.002Z"),
        leaseDurationMs: 10_000,
      });
      if (!replayClaim) throw new Error("expected replayed end claim");
      const replayedEnd = await store.applyOperatorMutation(replayClaim);
      expect(replayedEnd.workspaces.map(String)).toEqual(["workspace:acme"]);
      const revisionAfterReplay = rows(await db!.query(
        "SELECT revision FROM ONLY $subscription;",
        { subscription: id(activeSubscription) },
      ))[0]?.revision;
      expect(revisionAfterReplay).toBe(revisionAfterFirst);
      await store.settleOperatorIntent(replayClaim, {}, endAt);

      const invalidOverrideAt = new DateTime(
        "2026-08-15T00:00:00.000Z",
      );
      const invalidOverride: OperatorIntentSubmission = {
        kind: "override_schedule",
        actorSubject: "operator:alice",
        actorCapability: "override.manage",
        requestId: "invalid-override-terminal",
        workspace: id("workspace:acme"),
        customerReason: "请求临时配额",
        operatorReason: "输入校验测试",
        effectiveAt: invalidOverrideAt,
        input: {
          workspace: id("workspace:acme"),
          patches: [],
        },
        impactPreview: {},
        correlationId: "corr-invalid-override-terminal",
      };
      await store.persistOperatorIntent({
        ...invalidOverride,
        requiredCapability: "override.manage",
        inputDigest: operatorIntentDigest(invalidOverride),
        now: invalidOverrideAt,
      });
      const invalidClaim = await store.claimOperatorIntent({
        workerId: "worker-a",
        now: invalidOverrideAt,
        leaseDurationMs: 10_000,
      });
      if (!invalidClaim) throw new Error("expected invalid override claim");
      await expect(
        store.applyOperatorMutation(invalidClaim),
      ).rejects.toMatchObject({ code: "operator_intent_invalid" });
      await store.failOperatorIntent(invalidClaim, {
        errorCode: "operator_intent_invalid",
        errorDetails: { error_name: "QuotaLifecycleError" },
        failedAt: invalidOverrideAt,
      });
      await expect(store.claimOperatorIntent({
        workerId: "worker-b",
        now: new DateTime("2026-08-16T00:00:00.000Z"),
        leaseDurationMs: 10_000,
      })).resolves.toBeUndefined();
    },
    30_000,
  );
});
