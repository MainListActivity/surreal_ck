import { describe, expect, test } from "bun:test";
import { DateTime, StringRecordId } from "surrealdb";
import type { ProductQuotaRule, QuotaOverridePatch } from "@surreal-ck/shared/native-quota";
import {
  EntitlementResolutionError,
  resolveResourceEntitlement,
  type EntitlementBaseCandidate,
  type EntitlementPlanRevision,
} from "./entitlement-resolver";

const workspace = new StringRecordId("workspace:acme");
const at = new DateTime("2026-08-01T00:00:00.000Z");

function date(value: string): DateTime {
  return new DateTime(value);
}

function id(value: string): StringRecordId {
  return new StringRecordId(value);
}

function rules(recordLimit = 100): readonly ProductQuotaRule[] {
  return [{
    rule_key: "entity-records",
    resource: "record",
    selector: { kind: "regex", value: "^ent_" },
    limit: { kind: "finite", value: recordLimit },
    customer_label: "每张实体表记录数",
  }];
}

function planRevision(
  value = "quota_plan_revision:plus_v1",
  templateKind: EntitlementPlanRevision["template_kind"] = "commercial",
  planRules: readonly ProductQuotaRule[] = rules(),
): EntitlementPlanRevision {
  return {
    id: id(value),
    template_kind: templateKind,
    rules: planRules,
  };
}

function candidate(input: {
  itemId: string;
  accountId: string;
  source?: EntitlementBaseCandidate["subscription"]["source"];
  status?: EntitlementBaseCandidate["subscription"]["status"];
  effectiveFrom?: string;
  effectiveUntil?: string;
  plan?: EntitlementPlanRevision;
  trialStart?: string;
  trialEnd?: string;
  graceUntil?: string;
}): EntitlementBaseCandidate {
  const subscriptionId = id(`quota_subscription:${input.itemId}`);
  const selectedPlan = input.plan ?? planRevision();
  return {
    subscription: {
      id: subscriptionId,
      billing_account: id(`billing_account:${input.accountId}`),
      source: input.source ?? "provider",
      status: input.status ?? "active",
      trial_start: input.trialStart ? date(input.trialStart) : undefined,
      trial_end: input.trialEnd ? date(input.trialEnd) : undefined,
      grace_until: input.graceUntil ? date(input.graceUntil) : undefined,
    },
    item: {
      id: id(`quota_subscription_item:${input.itemId}`),
      subscription: subscriptionId,
      workspace,
      plan_revision: selectedPlan.id,
      status: "active",
      effective_from: date(input.effectiveFrom ?? "2026-07-01T00:00:00.000Z"),
      effective_until: input.effectiveUntil ? date(input.effectiveUntil) : undefined,
    },
    planRevision: selectedPlan,
  };
}

function resolutionInput(
  candidates: readonly EntitlementBaseCandidate[],
  overrides: Partial<Parameters<typeof resolveResourceEntitlement>[0]> = {},
): Parameters<typeof resolveResourceEntitlement>[0] {
  return {
    workspace,
    at,
    previouslyActivated: false,
    candidates,
    nextEntitlement: {
      id: id("resource_entitlement:acme_v2"),
      revision: 2,
    },
    correlationId: "corr-resolve",
    causationId: "cause-resolve",
    ...overrides,
  };
}

describe("resolveResourceEntitlement", () => {
  test("paid/contract/manual sources take priority over an otherwise valid trial", () => {
    const table = [
      {
        name: "provider paid",
        source: "provider" as const,
        expected: "paid",
      },
      {
        name: "enterprise contract",
        source: "contract" as const,
        expected: "contract",
      },
      {
        name: "manual assignment",
        source: "manual" as const,
        expected: "manual",
      },
    ];

    for (const row of table) {
      const commercial = candidate({
        itemId: `commercial_${row.source}`,
        accountId: row.source,
        source: row.source,
      });
      const trial = candidate({
        itemId: `trial_${row.source}`,
        accountId: "trial",
        status: "trialing",
        trialStart: "2026-07-20T00:00:00.000Z",
        trialEnd: "2026-08-10T00:00:00.000Z",
      });

      const result = resolveResourceEntitlement(
        resolutionInput([trial, commercial]),
      );

      expect(result.kind, row.name).toBe("resolved");
      if (result.kind !== "resolved") throw new Error("expected resolved");
      expect(result.entitlement.source_type).toBe(row.expected);
      expect(result.entitlement.subscription_item.toString()).toBe(
        commercial.item.id.toString(),
      );
      expect(result.entitlement.service_mode).toBe("standard");
    }
  });

  test("uses trial only when no paid, contract, or manual source is effective", () => {
    const trial = candidate({
      itemId: "trial",
      accountId: "trial-payer",
      status: "trialing",
      trialStart: "2026-08-01T00:00:00.000Z",
      trialEnd: "2026-08-10T00:00:00.000Z",
    });

    const result = resolveResourceEntitlement(resolutionInput([trial]));

    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") throw new Error("expected resolved");
    expect(result.entitlement.source_type).toBe("trial");
    expect(result.entitlement.effective_at.toString()).toBe(at.toString());
    expect(result.entitlement.effective_until?.toString()).toBe(
      "2026-08-10T00:00:00.000Z",
    );
  });

  test("treats start as inclusive and end as exclusive during an atomic payer switch", () => {
    const oldPayer = candidate({
      itemId: "old_payer",
      accountId: "old",
      effectiveUntil: "2026-08-01T00:00:00.000Z",
    });
    const newPayer = candidate({
      itemId: "new_payer",
      accountId: "new",
      effectiveFrom: "2026-08-01T00:00:00.000Z",
    });

    const result = resolveResourceEntitlement(
      resolutionInput([oldPayer, newPayer]),
    );

    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") throw new Error("expected resolved");
    expect(result.entitlement.subscription_item.toString()).toBe(
      newPayer.item.id.toString(),
    );
  });

  test("same rules but a new payer still create a new auditable source digest", () => {
    const oldPayer = candidate({ itemId: "old", accountId: "old" });
    const newPayer = candidate({ itemId: "new", accountId: "new" });
    const oldResult = resolveResourceEntitlement(
      resolutionInput([oldPayer], {
        nextEntitlement: {
          id: id("resource_entitlement:old"),
          revision: 1,
        },
      }),
    );
    if (oldResult.kind !== "resolved") throw new Error("expected old result");

    const newResult = resolveResourceEntitlement(
      resolutionInput([newPayer], {
        currentDesired: {
          id: oldResult.entitlement.id,
          source_digest: oldResult.entitlement.source_digest,
        },
      }),
    );

    expect(newResult.kind).toBe("resolved");
    if (newResult.kind !== "resolved") throw new Error("expected new result");
    expect(newResult.entitlement.source_digest).not.toBe(
      oldResult.entitlement.source_digest,
    );
  });

  test("returns unchanged when the same source and immutable rules are resolved again", () => {
    const paid = candidate({ itemId: "same", accountId: "same" });
    const first = resolveResourceEntitlement(resolutionInput([paid]));
    if (first.kind !== "resolved") throw new Error("expected resolved");

    const second = resolveResourceEntitlement(
      resolutionInput([paid], {
        currentDesired: {
          id: first.entitlement.id,
          source_digest: first.entitlement.source_digest,
        },
      }),
    );

    expect(second).toEqual({
      kind: "unchanged",
      desiredEntitlement: first.entitlement.id,
      sourceDigest: first.entitlement.source_digest,
    });
  });

  test("new workspace without a commercial source remains unresolved", () => {
    expect(resolveResourceEntitlement(resolutionInput([]))).toEqual({
      kind: "unresolved",
      reason: "no_eligible_source",
    });
  });

  test("previously activated workspace falls back to a zero-growth retention plan", () => {
    const retention = planRevision(
      "quota_plan_revision:retention_v1",
      "retention",
      rules(0),
    );
    const result = resolveResourceEntitlement(
      resolutionInput([], {
        previouslyActivated: true,
        retentionPlanRevision: retention,
      }),
    );

    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") throw new Error("expected resolved");
    expect(result.entitlement).toMatchObject({
      source_type: "retention",
      service_mode: "retention",
      subscription_item: undefined,
      plan_revision: retention.id,
      rules: rules(0),
    });
  });

  test("past_due keeps the source only before grace_until and marks grace service mode", () => {
    const beforeBoundary = candidate({
      itemId: "grace",
      accountId: "grace",
      status: "past_due",
      graceUntil: "2026-08-01T00:00:00.001Z",
    });
    const inGrace = resolveResourceEntitlement(
      resolutionInput([beforeBoundary]),
    );
    expect(inGrace.kind).toBe("resolved");
    if (inGrace.kind !== "resolved") throw new Error("expected resolved");
    expect(inGrace.entitlement.service_mode).toBe("grace");

    const atBoundary = candidate({
      itemId: "grace-ended",
      accountId: "grace",
      status: "past_due",
      graceUntil: "2026-08-01T00:00:00.000Z",
    });
    expect(resolveResourceEntitlement(resolutionInput([atBoundary]))).toEqual({
      kind: "unresolved",
      reason: "no_eligible_source",
    });
  });

  test("applies one active override and ignores it at the exclusive expiry boundary", () => {
    const paid = candidate({ itemId: "override", accountId: "override" });
    const patch: QuotaOverridePatch = {
      rule_key: "entity-records",
      action: "replace",
      limit: { kind: "finite", value: 250 },
    };
    const override = {
      id: id("quota_override_revision:acme_v1"),
      workspace,
      revision: 1,
      patches: [patch],
      effective_at: date("2026-07-31T00:00:00.000Z"),
      expires_at: date("2026-08-01T00:00:00.001Z"),
    };

    const active = resolveResourceEntitlement(
      resolutionInput([paid], { overrideRevision: override }),
    );
    expect(active.kind).toBe("resolved");
    if (active.kind !== "resolved") throw new Error("expected resolved");
    expect(active.entitlement.override_revision).toEqual(override.id);
    expect(active.entitlement.rules[0]?.limit).toEqual({
      kind: "finite",
      value: 250,
    });

    const expired = resolveResourceEntitlement(
      resolutionInput([paid], {
        overrideRevision: {
          ...override,
          expires_at: at,
        },
      }),
    );
    expect(expired.kind).toBe("resolved");
    if (expired.kind !== "resolved") throw new Error("expected resolved");
    expect(expired.entitlement.override_revision).toBeUndefined();
    expect(expired.entitlement.rules[0]?.limit).toEqual({
      kind: "finite",
      value: 100,
    });
  });

  test("rejects overlapping effective candidates in the same priority tier", () => {
    expect(() => resolveResourceEntitlement(
      resolutionInput([
        candidate({ itemId: "one", accountId: "one" }),
        candidate({ itemId: "two", accountId: "two" }),
      ]),
    )).toThrow(
      expect.objectContaining<Partial<EntitlementResolutionError>>({
        code: "overlapping_base_sources",
      }),
    );
  });

  test("rejects an override patch that references an unknown rule key", () => {
    const paid = candidate({ itemId: "unknown-patch", accountId: "payer" });

    expect(() => resolveResourceEntitlement(
      resolutionInput([paid], {
        overrideRevision: {
          id: id("quota_override_revision:bad"),
          workspace,
          revision: 1,
          patches: [{
            rule_key: "missing",
            action: "disable",
          }],
          effective_at: date("2026-07-31T00:00:00.000Z"),
        },
      }),
    )).toThrow(
      expect.objectContaining<Partial<EntitlementResolutionError>>({
        code: "unknown_override_rule",
      }),
    );
  });
});
