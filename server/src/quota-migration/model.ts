import {
  QUOTA_MIGRATION_BLOCKING_SIGNALS,
  QuotaMigrationAssignmentManifestSchema,
  type NativeQuotaInfo,
  type NativeQuotaRule,
  type QuotaMigrationAssignment,
  type QuotaMigrationAssignmentManifest,
  type QuotaMigrationCohort,
  type QuotaMigrationPhysicalScan,
  type QuotaMigrationPhysicalTable,
  type QuotaMigrationSignal,
  type QuotaMigrationTargetPreview,
} from "@surreal-ck/shared/native-quota";
import { canonicalSha256, stableSha256 } from "../quota/canonical";
import { canonicalNativePolicyDigest } from "../quota/policy-compiler";

const COHORT_ORDER: readonly QuotaMigrationCohort[] = Object.freeze([
  "synthetic_internal",
  "one_percent",
  "ten_percent",
  "fifty_percent",
  "remainder",
]);

export class QuotaMigrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    readonly pausesRun = false,
  ) {
    super(message);
    this.name = "QuotaMigrationError";
  }
}

function withoutChecksum<T extends { checksum: string }>(
  value: T,
): Omit<T, "checksum"> {
  const { checksum: _checksum, ...rest } = value;
  return rest;
}

export function migrationChecksum(value: unknown): string {
  return canonicalSha256(value);
}

export function physicalScanChecksum(
  tables: readonly QuotaMigrationPhysicalTable[],
): string {
  return migrationChecksum(
    [...tables]
      .map((table) => ({
        table: table.table,
        field_count: table.field_count,
        record_count: table.record_count,
      }))
      .sort((left, right) => left.table.localeCompare(right.table)),
  );
}

export function verifyManifestChecksum(
  input: unknown,
): QuotaMigrationAssignmentManifest {
  const manifest = QuotaMigrationAssignmentManifestSchema.parse(input);
  const expected = migrationChecksum(withoutChecksum(manifest));
  if (manifest.checksum !== expected) {
    throw new QuotaMigrationError(
      "migration_manifest_checksum_mismatch",
      "assignment manifest checksum does not match its canonical content",
      { expected, actual: manifest.checksum },
    );
  }
  return manifest;
}

export function assignMigrationCohorts(
  assignments: readonly QuotaMigrationAssignment[],
): ReadonlyMap<string, QuotaMigrationCohort> {
  const result = new Map<string, QuotaMigrationCohort>();
  const standard = assignments
    .filter((assignment) => assignment.rollout_class === "standard")
    .map((assignment) => ({
      workspace: assignment.workspace_id,
      hash: stableSha256(assignment.workspace_id),
    }))
    .sort((left, right) =>
      left.hash.localeCompare(right.hash)
      || left.workspace.localeCompare(right.workspace)
    );

  for (const assignment of assignments) {
    if (assignment.rollout_class !== "standard") {
      result.set(assignment.workspace_id, "synthetic_internal");
    }
  }

  const count = standard.length;
  const onePercentEnd = count === 0
    ? 0
    : Math.max(1, Math.ceil(count * 0.01));
  const tenPercentEnd = Math.max(onePercentEnd, Math.ceil(count * 0.1));
  const fiftyPercentEnd = Math.max(tenPercentEnd, Math.ceil(count * 0.5));
  standard.forEach((entry, index) => {
    const cohort = index < onePercentEnd
      ? "one_percent"
      : index < tenPercentEnd
      ? "ten_percent"
      : index < fiftyPercentEnd
      ? "fifty_percent"
      : "remainder";
    result.set(entry.workspace, cohort);
  });

  return result;
}

export function cohortOrdinal(cohort: QuotaMigrationCohort): number {
  return COHORT_ORDER.indexOf(cohort);
}

export function cohortObservationHours(
  cohort: QuotaMigrationCohort,
): number {
  if (cohort === "synthetic_internal" || cohort === "one_percent") {
    return 24;
  }
  if (cohort === "ten_percent" || cohort === "fifty_percent") {
    return 48;
  }
  return 0;
}

function selectorMatches(rule: NativeQuotaRule, table: string): boolean {
  return rule.selector.kind === "exact"
    ? rule.selector.table === table
    : new RegExp(rule.selector.pattern, "u").test(table);
}

function decimal(value: number | bigint): string {
  return value.toString();
}

function finiteLimit(
  rules: readonly NativeQuotaRule[],
): bigint | undefined {
  const finite = rules
    .filter((rule) => rule.limit.kind === "finite")
    .map((rule) => BigInt(
      rule.limit.kind === "finite" ? rule.limit.value : 0,
    ));
  if (finite.length === 0) return undefined;
  return finite.reduce((left, right) => left < right ? left : right);
}

export function buildTargetOverage(
  rules: readonly NativeQuotaRule[],
  physical: QuotaMigrationPhysicalScan,
): QuotaMigrationTargetPreview["overage"] {
  const overage: QuotaMigrationTargetPreview["overage"][number][] = [];
  const tableRules = rules.filter((rule) => rule.resource === "table");
  for (const rule of tableRules) {
    if (rule.limit.kind !== "finite") continue;
    const used = BigInt(
      physical.tables.filter((table) => selectorMatches(rule, table.table))
        .length,
    );
    const limit = BigInt(rule.limit.value);
    if (used > limit) {
      overage.push({
        resource: "table",
        table: null,
        used: decimal(used),
        limit: decimal(limit),
        over_by: decimal(used - limit),
      });
    }
  }

  for (const table of physical.tables) {
    for (const resource of ["field", "record"] as const) {
      const matching = rules.filter((rule) =>
        rule.resource === resource && selectorMatches(rule, table.table)
      );
      const limit = finiteLimit(matching);
      if (limit === undefined) continue;
      const used = BigInt(
        resource === "field" ? table.field_count : table.record_count,
      );
      if (used > limit) {
        overage.push({
          resource,
          table: table.table,
          used: decimal(used),
          limit: decimal(limit),
          over_by: decimal(used - limit),
        });
      }
    }
  }
  return overage;
}

export type NativeScanComparison = Readonly<{
  ok: boolean;
  errors: readonly Readonly<{
    code: string;
    details: Readonly<Record<string, unknown>>;
  }>[];
}>;

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

export function compareNativeUsageToPhysicalScan(
  info: NativeQuotaInfo,
  physical: QuotaMigrationPhysicalScan,
  expectedPolicyDigest?: string,
): NativeScanComparison {
  const errors: {
    code: string;
    details: Readonly<Record<string, unknown>>;
  }[] = [];
  const actualScanChecksum = physicalScanChecksum(physical.tables);
  if (actualScanChecksum !== physical.scan_checksum) {
    errors.push({
      code: "physical_scan_checksum_mismatch",
      details: {
        expected: physical.scan_checksum,
        actual: actualScanChecksum,
      },
    });
  }
  if (
    info.ledger.state !== "ready"
    || !info.ledger.usage_trusted
    || !info.usage
  ) {
    errors.push({
      code: info.ledger.state === "corrupt"
        ? "ledger_corrupt"
        : "ledger_not_ready",
      details: {
        state: info.ledger.state,
        usage_trusted: info.ledger.usage_trusted,
      },
    });
    return Object.freeze({ ok: false, errors: Object.freeze(errors) });
  }
  if (!info.policy && expectedPolicyDigest) {
    errors.push({
      code: "native_policy_missing",
      details: {},
    });
  } else if (
    expectedPolicyDigest
    && info.policy
    && canonicalNativePolicyDigest(info.policy.rules) !== expectedPolicyDigest
  ) {
    errors.push({
      code: "native_policy_digest_mismatch",
      details: {
        expected: expectedPolicyDigest,
        actual: canonicalNativePolicyDigest(info.policy.rules),
      },
    });
  }

  const infoTables = new Map(
    info.usage.tables.map((table) => [table.table, table]),
  );
  const scanTables = new Map(
    physical.tables.map((table) => [table.table, table]),
  );
  if (!sameStrings([...infoTables.keys()], [...scanTables.keys()])) {
    errors.push({
      code: "native_table_catalog_mismatch",
      details: {
        native: sorted([...infoTables.keys()]),
        physical: sorted([...scanTables.keys()]),
      },
    });
  }
  for (const [tableName, scan] of scanTables) {
    const observed = infoTables.get(tableName);
    if (!observed) continue;
    if (BigInt(observed.field.used) !== BigInt(scan.field_count)) {
      errors.push({
        code: "native_field_counter_mismatch",
        details: {
          table: tableName,
          native: observed.field.used.toString(),
          physical: scan.field_count,
        },
      });
    }
    if (BigInt(observed.record.used) !== BigInt(scan.record_count)) {
      errors.push({
        code: "native_record_counter_mismatch",
        details: {
          table: tableName,
          native: observed.record.used.toString(),
          physical: scan.record_count,
        },
      });
    }
  }

  if (info.policy) {
    const policy = info.policy;
    const tableRules = policy.rules.filter(
      (rule) => rule.resource === "table",
    );
    for (const rule of tableRules) {
      const expected = physical.tables.filter((table) =>
        selectorMatches(rule, table.table)
      ).length;
      const bucket = info.usage.table_buckets.find(
        (candidate) => candidate.rule_id === rule.rule_id,
      );
      if (!bucket || BigInt(bucket.used) !== BigInt(expected)) {
        errors.push({
          code: "native_table_counter_mismatch",
          details: {
            rule_id: rule.rule_id,
            native: bucket?.used.toString(),
            physical: expected.toString(),
          },
        });
      }
    }
    for (const resource of ["table", "field", "record"] as const) {
      const expectedUnmatched = physical.tables
        .filter((table) =>
          !policy.rules.some((rule) =>
            rule.resource === resource && selectorMatches(rule, table.table)
          )
        )
        .map((table) => table.table);
      if (!sameStrings(info.usage.unmatched[resource], expectedUnmatched)) {
        errors.push({
          code: "native_unmatched_coverage_mismatch",
          details: {
            resource,
            native: sorted(info.usage.unmatched[resource]),
            physical: sorted(expectedUnmatched),
          },
        });
      }
    }
  }
  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
  });
}

export function isBlockingMigrationSignal(
  signal: QuotaMigrationSignal,
): boolean {
  return (QUOTA_MIGRATION_BLOCKING_SIGNALS as readonly string[]).includes(
    signal.kind,
  );
}
