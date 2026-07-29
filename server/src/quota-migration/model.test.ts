import { describe, expect, test } from "bun:test";
import type {
  NativeQuotaInfo,
  QuotaMigrationAssignment,
  QuotaMigrationPhysicalScan,
} from "@surreal-ck/shared/native-quota";
import {
  assignMigrationCohorts,
  buildTargetOverage,
  compareNativeUsageToPhysicalScan,
  migrationChecksum,
  physicalScanChecksum,
  verifyManifestChecksum,
} from "./model";
import { canonicalNativePolicyDigest } from "../quota/policy-compiler";

function assignment(
  index: number,
  rolloutClass: QuotaMigrationAssignment["rollout_class"] = "standard",
): QuotaMigrationAssignment {
  return {
    workspace_id: `workspace:w${index}`,
    workspace_slug: `w${index}`,
    database: `ws_w${index}`,
    billing_account_id: "billing_account:acme",
    plan_revision_id: "quota_plan_revision:plus_v1",
    source: "manual",
    effective_at: "2026-07-29T00:00:00.000Z",
    rollout_class: rolloutClass,
    evidence_reference: `contract-${index}`,
  };
}

const physicalTables = [
  { table: "ent_case", field_count: "3", record_count: "12" },
  { table: "sheet", field_count: "8", record_count: "1" },
] as const;
const physical: QuotaMigrationPhysicalScan = {
  tables: [...physicalTables],
  totals: { table_count: "2", field_count: "11", record_count: "13" },
  scan_checksum: physicalScanChecksum(physicalTables),
};
const rules = [
  {
    rule_id: "tables-ent",
    resource: "table" as const,
    selector: { kind: "regex" as const, pattern: "^ent_" },
    limit: { kind: "finite" as const, value: 1 },
  },
  {
    rule_id: "fields-ent",
    resource: "field" as const,
    selector: { kind: "regex" as const, pattern: "^ent_" },
    limit: { kind: "finite" as const, value: 3 },
  },
  {
    rule_id: "records-ent",
    resource: "record" as const,
    selector: { kind: "regex" as const, pattern: "^ent_" },
    limit: { kind: "finite" as const, value: 10 },
  },
  {
    rule_id: "fallback-table",
    resource: "table" as const,
    selector: { kind: "regex" as const, pattern: ".*" },
    limit: { kind: "unlimited" as const },
  },
  {
    rule_id: "fallback-field",
    resource: "field" as const,
    selector: { kind: "regex" as const, pattern: ".*" },
    limit: { kind: "unlimited" as const },
  },
  {
    rule_id: "fallback-record",
    resource: "record" as const,
    selector: { kind: "regex" as const, pattern: ".*" },
    limit: { kind: "unlimited" as const },
  },
];

function nativeInfo(): NativeQuotaInfo {
  return {
    database: "ws_w1",
    format_version: 1,
    latest_change: null,
    ledger: { active_epoch: 1, state: "ready", usage_trusted: true },
    observed_at: "2026-07-29T00:00:00.000Z",
    policy: { generation: 4, rules },
    usage: {
      table_buckets: [
        {
          rule_id: "tables-ent",
          used: 1,
          exceeded: false,
          limit: { kind: "finite", value: 1 },
          remaining: 0,
        },
        {
          rule_id: "fallback-table",
          used: 2,
          exceeded: false,
          limit: { kind: "unlimited" },
          remaining: null,
        },
      ],
      tables: [
        {
          table: "ent_case",
          field: {
            effective_rule_ids: ["fields-ent"],
            exceeded: false,
            limit: { kind: "finite", value: 3 },
            limit_origin: "regex_min",
            matched_rule_ids: ["fields-ent", "fallback-field"],
            remaining: 0,
            used: 3,
          },
          record: {
            effective_rule_ids: ["records-ent"],
            exceeded: true,
            limit: { kind: "finite", value: 10 },
            limit_origin: "regex_min",
            matched_rule_ids: ["records-ent", "fallback-record"],
            remaining: 0,
            used: 12,
          },
        },
        {
          table: "sheet",
          field: {
            effective_rule_ids: ["fallback-field"],
            exceeded: false,
            limit: { kind: "unlimited" },
            limit_origin: "explicit_unlimited",
            matched_rule_ids: ["fallback-field"],
            remaining: null,
            used: 8,
          },
          record: {
            effective_rule_ids: ["fallback-record"],
            exceeded: false,
            limit: { kind: "unlimited" },
            limit_origin: "explicit_unlimited",
            matched_rule_ids: ["fallback-record"],
            remaining: null,
            used: 1,
          },
        },
      ],
      unmatched: { table: [], field: [], record: [] },
    },
  };
}

describe("quota migration pure model", () => {
  test("manifest checksum covers mapping and every approved assignment", () => {
    const unsigned = {
      format_version: 1 as const,
      manifest_id: "migration-2026-07",
      inventory_checksum: `sha256:${"1".repeat(64)}`,
      approved_by_subject: "operator:alice",
      approved_at: "2026-07-29T00:00:00.000Z",
      assignments: [assignment(1)],
    };
    const manifest = {
      ...unsigned,
      checksum: migrationChecksum(unsigned),
    };
    expect(verifyManifestChecksum(manifest)).toEqual(manifest);
    expect(() =>
      verifyManifestChecksum({
        ...manifest,
        assignments: [{ ...assignment(1), database: "ws_other" }],
      })
    ).toThrow("checksum");
  });

  test("cohorts are deterministic and standard 1% always has at least one", () => {
    const assignments = [
      assignment(0, "synthetic"),
      ...Array.from({ length: 101 }, (_, index) => assignment(index + 1)),
    ];
    const first = assignMigrationCohorts(assignments);
    const second = assignMigrationCohorts([...assignments].reverse());
    expect(first.get("workspace:w0")).toBe("synthetic_internal");
    expect([...first.entries()].sort()).toEqual([...second.entries()].sort());
    expect(
      [...first.values()].filter((cohort) => cohort === "one_percent"),
    ).toHaveLength(2);
  });

  test("physical scan must exactly match native field/record/table buckets", () => {
    const info = nativeInfo();
    const digest = canonicalNativePolicyDigest(rules);
    expect(compareNativeUsageToPhysicalScan(info, physical, digest)).toEqual({
      ok: true,
      errors: [],
    });

    const mismatch = structuredClone(info);
    if (!mismatch.usage) throw new Error("fixture usage missing");
    mismatch.usage.tables[0]!.record.used = 11;
    const compared = compareNativeUsageToPhysicalScan(
      mismatch,
      physical,
      digest,
    );
    expect(compared.ok).toBe(false);
    expect(compared.errors.map((error) => error.code)).toContain(
      "native_record_counter_mismatch",
    );
  });

  test("target preview reports overage without importing old counters", () => {
    expect(buildTargetOverage(rules, physical)).toEqual([
      {
        resource: "record",
        table: "ent_case",
        used: "12",
        limit: "10",
        over_by: "2",
      },
    ]);
  });
});
