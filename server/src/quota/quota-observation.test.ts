import { describe, expect, test } from "bun:test";
import type { NativeQuotaInfo } from "@surreal-ck/shared/native-quota";
import { DateTime, StringRecordId } from "surrealdb";
import { canonicalNativePolicyDigest } from "./policy-compiler";
import {
  QuotaObservationService,
  SurrealQuotaObservationStore,
  type QuotaObservationStore,
  type QuotaRuntimeObservation,
} from "./quota-observation";
import type { QuotaWorkspaceAuthority } from "./quota-read-service";

function info(input: {
  used: number;
  limit: number;
  trusted?: boolean;
}): NativeQuotaInfo {
  const trusted = input.trusted ?? true;
  return {
    database: "ws_demo",
    format_version: 1,
    latest_change: null,
    ledger: {
      active_epoch: 1,
      state: "ready",
      usage_trusted: trusted,
    },
    observed_at: "2026-07-28T00:00:00.000Z",
    policy: {
      generation: 3,
      rules: [{
        rule_id: "record-ent",
        resource: "record",
        selector: { kind: "regex", pattern: "^ent_" },
        limit: { kind: "finite", value: input.limit },
      }],
    },
    usage: {
      table_buckets: [],
      tables: [{
        table: "ent_case",
        field: {
          effective_rule_ids: [],
          exceeded: false,
          limit: { kind: "unlimited" },
          limit_origin: "unmatched",
          matched_rule_ids: [],
          remaining: null,
          used: 2,
        },
        record: {
          effective_rule_ids: ["record-ent"],
          exceeded: input.used > input.limit,
          limit: { kind: "finite", value: input.limit },
          limit_origin: "regex_min",
          matched_rule_ids: ["record-ent"],
          remaining:
            input.used <= input.limit ? input.limit - input.used : null,
          used: input.used,
        },
      }],
      unmatched: { table: [], field: ["ent_case"], record: [] },
    },
  };
}

function authority(nativeInfo: NativeQuotaInfo): QuotaWorkspaceAuthority {
  const rules = nativeInfo.policy?.rules ?? [];
  return {
    workspace: {
      record: "workspace:demo",
      slug: "demo",
      name: "Demo",
      database: "ws_demo",
    },
    workspaceRole: "admin",
    operatorCapabilities: [],
    appliedProjection: {
      record: "quota_policy_projection:applied",
      canonicalDigest: canonicalNativePolicyDigest(rules),
      rules: [{
        rule_id: "record-ent",
        rule_key: "record/ent",
        resource: "record",
        selector: { kind: "regex", pattern: "^ent_" },
        limit: { kind: "finite", value: 100 },
        customer_label: "实体记录",
      }],
    },
    desiredProjection: {
      record: "quota_policy_projection:applied",
      canonicalDigest: canonicalNativePolicyDigest(rules),
      rules: [],
    },
    runtime: {
      sync: "pending",
      serviceMode: "standard",
      compliance: "unknown",
      capacity: "unknown",
      ledger: "ready",
      usageTrusted: false,
      autoReconcile: true,
      updatedAt: "2026-07-28T00:00:00.000Z",
    },
    commercialStateAt: "2026-07-28T00:00:00.000Z",
  };
}

function fakeStore() {
  const runtime: QuotaRuntimeObservation[] = [];
  const persisted: Parameters<QuotaObservationStore["persistAlertTransitions"]>[0][] = [];
  let recipientLoads = 0;
  const store: QuotaObservationStore = {
    async recordRuntime(value) {
      runtime.push(value);
    },
    async loadAlertSnapshots() {
      return [];
    },
    async loadAlertRecipients() {
      recipientLoads += 1;
      return {
        workspaceAdmins: ["admin"],
        billingAdmins: ["payer"],
      };
    },
    async persistAlertTransitions(value) {
      persisted.push(value);
    },
  };
  return { store, runtime, persisted, recipientLoads: () => recipientLoads };
}

describe("QuotaObservationService", () => {
  test("records trusted capacity and emits only reached threshold transitions", async () => {
    const nativeInfo = info({ used: 91, limit: 100 });
    const fake = fakeStore();
    await new QuotaObservationService(
      fake.store,
      () => Date.parse("2026-07-28T00:00:01.000Z"),
    ).observe({
      authority: authority(nativeInfo),
      info: nativeInfo,
    });

    expect(fake.runtime[0]).toMatchObject({
      usageTrusted: true,
      capacity: "critical",
      compliance: "compliant",
      sync: "in_sync",
      nativeGeneration: 3,
    });
    expect(
      fake.persisted[0]?.transitions
        .filter((transition) => transition.action === "notify")
        .map((transition) => [
          transition.snapshot.kind,
          transition.snapshot.threshold,
        ]),
    ).toEqual([
      ["threshold", 80],
      ["threshold", 90],
    ]);
    expect(fake.recipientLoads()).toBe(1);
  });

  test("untrusted usage persists unknown and never evaluates alerts", async () => {
    const nativeInfo = info({ used: 0, limit: 0, trusted: false });
    const fake = fakeStore();
    await new QuotaObservationService(fake.store).observe({
      authority: authority(nativeInfo),
      info: nativeInfo,
    });
    expect(fake.runtime[0]).toMatchObject({
      usageTrusted: false,
      capacity: "unknown",
      compliance: "unknown",
    });
    expect(fake.persisted).toEqual([]);
    expect(fake.recipientLoads()).toBe(0);
  });

  test("finite zero with zero usage is at-limit but not over-limit", async () => {
    const nativeInfo = info({ used: 0, limit: 0 });
    const fake = fakeStore();
    await new QuotaObservationService(fake.store).observe({
      authority: authority(nativeInfo),
      info: nativeInfo,
    });
    expect(fake.runtime[0]).toMatchObject({
      capacity: "at_limit",
      compliance: "compliant",
    });
    expect(
      fake.persisted[0]?.transitions.some(
        (transition) => transition.snapshot.kind === "over_limit",
      ),
    ).toBe(false);
  });
});

describe("SurrealQuotaObservationStore audience trimming", () => {
  test("80% is workspace-only; billing payload at 90% omits physical table", async () => {
    const writes: Array<Record<string, unknown> | undefined> = [];
    const store = new SurrealQuotaObservationStore({
      db: {
        async query(_sql, params) {
          writes.push(params);
          return [];
        },
      },
    });
    const base = {
      projection: "quota_policy_projection:applied",
      kind: "threshold" as const,
      resourceKey: "record/ent",
      tableIdentity: "ent_secret",
      episode: 1,
      state: "notified" as const,
      used: 90n,
      limit: 100n,
      ratioPercent: 90,
    };
    await store.persistAlertTransitions({
      workspace: new StringRecordId("workspace:demo"),
      projection: new StringRecordId("quota_policy_projection:applied"),
      recipients: {
        workspaceAdmins: ["same-person"],
        billingAdmins: ["same-person", "payer"],
        billingAccount: new StringRecordId("billing_account:team"),
      },
      labels: new Map([["record/ent", "实体记录"]]),
      observedAt: new DateTime("2026-07-28T00:00:00.000Z"),
      transitions: [
        {
          action: "notify",
          dedupeKey: "threshold-80",
          snapshot: { ...base, threshold: 80 },
        },
        {
          action: "notify",
          dedupeKey: "threshold-90",
          snapshot: { ...base, threshold: 90 },
        },
      ],
    });

    const notifications = writes
      .map((params) => params?.notification_content)
      .filter(
        (content): content is Record<string, unknown> =>
          typeof content === "object" && content !== null,
      );
    expect(
      notifications.map((notification) => [
        notification.audience,
        notification.recipient_subject,
      ]),
    ).toEqual([
      ["workspace_admin", "same-person"],
      ["workspace_admin", "same-person"],
      ["billing_admin", "payer"],
    ]);
    const billing = notifications.find(
      (notification) => notification.audience === "billing_admin",
    );
    expect(billing?.payload).toMatchObject({
      label: "实体记录",
      threshold_percent: 90,
    });
    expect(
      (billing?.payload as Record<string, unknown> | undefined)?.table_identity,
    ).toBeUndefined();
  });
});
