import { describe, expect, test } from "bun:test";
import type { NativeQuotaClient } from "../db/native-quota/client";
import { QuotaInfoCache } from "./quota-info-cache";
import {
  QuotaReadService,
  type QuotaAuthorityReader,
  type QuotaWorkspaceAuthority,
} from "./quota-read-service";
import { canonicalNativePolicyDigest } from "./policy-compiler";

function authority(
  overrides: Partial<QuotaWorkspaceAuthority> = {},
): QuotaWorkspaceAuthority {
  return {
    workspace: {
      record: "workspace:demo",
      slug: "demo",
      name: "Demo",
      database: "ws_demo",
    },
    workspaceRole: "admin",
    operatorCapabilities: [],
    appliedEntitlement: {
      record: "resource_entitlement:applied",
      revision: 1,
      source: "paid",
      serviceMode: "standard",
      effectiveAt: "2026-07-01T00:00:00.000Z",
      planKey: "plus",
      planName: "Plus",
      planRevision: 2,
    },
    desiredEntitlement: {
      record: "resource_entitlement:desired",
      revision: 2,
      source: "paid",
      serviceMode: "standard",
      effectiveAt: "2026-08-01T00:00:00.000Z",
      planKey: "pro",
      planName: "Pro",
      planRevision: 3,
    },
    appliedProjection: {
      record: "quota_policy_projection:applied",
      canonicalDigest: canonicalNativePolicyDigest([
        {
          rule_id: "record-ent",
          resource: "record",
          selector: { kind: "regex", pattern: "^ent_" },
          limit: { kind: "finite", value: 10 },
        },
        {
          rule_id: "field-zero",
          resource: "field",
          selector: { kind: "exact", table: "frozen" },
          limit: { kind: "finite", value: 0 },
        },
      ]),
      rules: [
        {
          rule_id: "record-ent",
          rule_key: "record/ent",
          resource: "record",
          selector: { kind: "regex", pattern: "^ent_" },
          limit: { kind: "finite", value: 10 },
          customer_label: "实体表记录",
          customer_description: "ent 开头的每张表",
        },
        {
          rule_id: "field-zero",
          rule_key: "field/frozen",
          resource: "field",
          selector: { kind: "exact", table: "frozen" },
          limit: { kind: "finite", value: 0 },
          customer_label: "冻结表字段",
        },
      ],
    },
    desiredProjection: {
      record: "quota_policy_projection:desired",
      canonicalDigest: "desired-digest",
      rules: [],
    },
    subscriptionStatus: "active",
    runtime: {
      sync: "pending",
      compliance: "compliant",
      capacity: "at_limit",
      serviceMode: "standard",
      ledger: "ready",
      usageTrusted: true,
      autoReconcile: true,
      nativeGeneration: 4,
      nativeDigest: "applied-digest",
      updatedAt: "2026-07-28T00:00:00.000Z",
    },
    commercialStateAt: "2026-07-28T00:00:00.000Z",
    ...overrides,
  };
}

function nativeInfo(usageTrusted = true) {
  return {
    database: "ws_demo",
    format_version: 1,
    latest_change: null,
    ledger: {
      active_epoch: 1,
      state: "ready" as const,
      usage_trusted: usageTrusted,
    },
    observed_at: "2026-07-28T00:00:00.000Z",
    policy: {
      generation: 4,
      rules: [
        {
          rule_id: "record-ent",
          resource: "record" as const,
          selector: { kind: "regex" as const, pattern: "^ent_" },
          limit: { kind: "finite" as const, value: 10 },
        },
        {
          rule_id: "field-zero",
          resource: "field" as const,
          selector: { kind: "exact" as const, table: "frozen" },
          limit: { kind: "finite" as const, value: 0 },
        },
      ],
    },
    usage: {
      table_buckets: [],
      tables: [{
        table: "ent_secret",
        field: {
          effective_rule_ids: [],
          exceeded: false,
          limit: { kind: "unlimited" as const },
          limit_origin: "unmatched" as const,
          matched_rule_ids: [],
          remaining: null,
          used: 3,
        },
        record: {
          effective_rule_ids: ["record-ent"],
          exceeded: false,
          limit: { kind: "finite" as const, value: 10 },
          limit_origin: "regex_min" as const,
          matched_rule_ids: ["record-ent"],
          remaining: 0,
          used: 10,
        },
      }],
      unmatched: { table: [], field: ["ent_secret"], record: [] },
    },
  };
}

function service(input: {
  authority: QuotaWorkspaceAuthority;
  usageTrusted?: boolean;
  nativeCalls?: { count: number };
}) {
  const reader: QuotaAuthorityReader = {
    async findWorkspaceAuthority({ slug }) {
      return slug === "demo" ? input.authority : null;
    },
    async findBillingAuthority() {
      return null;
    },
  };
  const native: NativeQuotaClient = {
    async info() {
      if (input.nativeCalls) input.nativeCalls.count += 1;
      return nativeInfo(input.usageTrusted);
    },
    async applyPolicy() {
      throw new Error("not used");
    },
    async rebuild() {
      throw new Error("not used");
    },
  };
  return new QuotaReadService(
    reader,
    native,
    new QuotaInfoCache(),
    undefined,
    { now: () => Date.parse("2026-07-28T00:01:00.000Z") },
  );
}

describe("QuotaReadService role allowlists", () => {
  test("participant receives no plan or whole-table usage and does not call INFO", async () => {
    const nativeCalls = { count: 0 };
    const result = await service({
      authority: authority({
        workspaceRole: "participant",
        appliedEntitlement: undefined,
        desiredEntitlement: undefined,
        appliedProjection: undefined,
        desiredProjection: undefined,
      }),
      nativeCalls,
    }).getWorkspace({
      slug: "demo",
      actor: { subject: "member" },
    });

    expect(result).toEqual({
      kind: "ok",
      view: {
        format_version: 1,
        view: "participant",
        viewer: { subject: "member", capabilities: [] },
        workspace: { id: "workspace:demo", slug: "demo", name: "Demo" },
        actions: ["contact_workspace_admin"],
      },
    });
    expect(nativeCalls.count).toBe(0);
  });

  test("non-member billing admin sees aggregate only", async () => {
    const result = await service({
      authority: authority({
        workspaceRole: undefined,
        billingRole: "admin",
      }),
    }).getWorkspace({
      slug: "demo",
      actor: { subject: "payer" },
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected view");
    expect(result.view.view).toBe("billing_admin");
    expect(result.view).toMatchObject({
      plan_key: "plus",
      utilization: {
        highest_percent: 100,
        usage_trusted: true,
      },
    });
    const serialized = JSON.stringify(result.view);
    expect(serialized).not.toContain("ent_secret");
    expect(serialized).not.toContain("^ent_");
    expect(serialized).not.toContain("resources");
  });

  test("workspace admin sees applied and pending desired separately with regex expansion", async () => {
    const result = await service({
      authority: authority(),
    }).getWorkspace({
      slug: "demo",
      actor: { subject: "admin" },
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok" || result.view.view !== "workspace_admin") {
      throw new Error("expected workspace admin view");
    }
    expect(result.view.applied?.plan_key).toBe("plus");
    expect(result.view.desired?.plan_key).toBe("pro");
    expect(result.view.statuses.sync).toBe("pending");
    expect(result.view.resources[0]).toMatchObject({
      key: "record/ent:ent_secret",
      selector: {
        kind: "regex",
        pattern: "^ent_",
        matched_tables: ["ent_secret"],
      },
      usage: {
        kind: "finite",
        used: 10,
        limit: 10,
        at_limit: true,
        over_limit: false,
      },
    });
    expect(result.view.resources[1]?.usage).toMatchObject({
      kind: "finite",
      used: 0,
      limit: 0,
      at_limit: true,
      over_limit: false,
    });
  });

  test("untrusted usage is unknown rather than zero", async () => {
    const result = await service({
      authority: authority(),
      usageTrusted: false,
    }).getWorkspace({
      slug: "demo",
      actor: { subject: "admin" },
    });
    if (result.kind !== "ok" || result.view.view !== "workspace_admin") {
      throw new Error("expected workspace admin view");
    }
    expect(result.view.usage_trusted).toBe(false);
    expect(result.view.resources[0]?.usage).toMatchObject({
      used: null,
      remaining: null,
      utilization_percent: null,
      at_limit: null,
      over_limit: null,
    });
  });

  test("operator capability is unioned with workspace and billing roles", async () => {
    const result = await service({
      authority: authority({
        billingRole: "owner",
        operatorCapabilities: ["quota.read", "reconcile.audit"],
      }),
    }).getWorkspace({
      slug: "demo",
      actor: { subject: "all-roles" },
    });
    if (result.kind !== "ok" || result.view.view !== "operator") {
      throw new Error("expected operator view");
    }
    expect(result.view.viewer.capabilities).toEqual([
      "workspace_quota.read",
      "billing_quota.read",
      "quota.read",
    ]);
    expect(result.view.operator).toMatchObject({
      database: "ws_demo",
      desired_projection: "quota_policy_projection:desired",
      applied_projection: "quota_policy_projection:applied",
      native_generation: 4,
    });
  });

  test("an object id or slug without membership is not authorization", async () => {
    const result = await service({
      authority: authority({
        workspaceRole: undefined,
        billingRole: undefined,
        operatorCapabilities: [],
      }),
    }).getWorkspace({
      slug: "demo",
      actor: { subject: "stranger" },
    });
    expect(result).toEqual({ kind: "not_found" });
  });
});
