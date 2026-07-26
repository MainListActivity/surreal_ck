import {
  NATIVE_QUOTA_EXPECTED_CONTRACT,
  type CompiledQuotaRule,
  type CompiledQuotaRuleLabel,
  type NativeQuotaLimit,
  type NativeQuotaResource,
  type ProductQuotaRule,
  type QuotaPolicyProjectionRecord,
  type ResourceEntitlementRecord,
  type SurrealInteger,
} from "@surreal-ck/shared/native-quota";
import type { DateTime, StringRecordId } from "surrealdb";
import { canonicalSha256, stableSha256 } from "./canonical";

export const QUOTA_POLICY_COMPILER_VERSION = "quota-policy-compiler-v1";
const MAX_CONTROL_PLANE_LIMIT = 9_223_372_036_854_775_807n;
const REQUIRED_RESOURCES = ["table", "field", "record"] as const;
const MANAGED_TABLE_PATTERN = "^ent_";
const FALLBACK_PATTERN = ".*";
const REGEX_SIZE_LIMIT = 10 * 1024 * 1024;

export type PolicyCompileErrorCode =
  | "invalid_rule"
  | "unknown_resource"
  | "duplicate_rule_key"
  | "duplicate_selector"
  | "invalid_selector"
  | "invalid_regex"
  | "limit_out_of_range"
  | "missing_fallback"
  | "missing_managed_rule"
  | "invalid_retention_policy";

export class PolicyCompileError extends Error {
  constructor(
    readonly code: PolicyCompileErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "PolicyCompileError";
  }
}

export type CompileQuotaPolicyInput = Readonly<{
  projection: Readonly<{
    id: StringRecordId;
    revision: SurrealInteger;
    createdAt: DateTime;
  }>;
  entitlement: ResourceEntitlementRecord;
}>;

export type CompiledQuotaPolicy = Readonly<{
  projection: QuotaPolicyProjectionRecord;
  rules: readonly CompiledQuotaRule[];
  ruleLabels: readonly CompiledQuotaRuleLabel[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResource(value: unknown, ruleKey: string): NativeQuotaResource {
  if (value === "table" || value === "field" || value === "record") {
    return value;
  }
  throw new PolicyCompileError(
    "unknown_resource",
    `unknown quota resource for rule ${ruleKey}: ${String(value)}`,
    { ruleKey, resource: value },
  );
}

function validateRegex(pattern: string, ruleKey: string): void {
  if (new TextEncoder().encode(pattern).length > REGEX_SIZE_LIMIT) {
    throw new PolicyCompileError(
      "invalid_regex",
      `quota selector regex exceeds the native size limit: ${ruleKey}`,
      { ruleKey },
    );
  }
  if (
    /\(\?(?:[=!]|<[=!])/u.test(pattern)
    || /\\(?:[1-9]|k<)/u.test(pattern)
  ) {
    throw new PolicyCompileError(
      "invalid_regex",
      `quota selector uses regex syntax unsupported by the native Rust engine: ${ruleKey}`,
      { ruleKey, pattern },
    );
  }
  try {
    new RegExp(pattern, "u");
  } catch (error) {
    throw new PolicyCompileError(
      "invalid_regex",
      `invalid quota selector regex for rule ${ruleKey}`,
      {
        ruleKey,
        pattern,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

function parseLimit(value: unknown, ruleKey: string): NativeQuotaLimit {
  if (!isRecord(value)) {
    throw new PolicyCompileError(
      "invalid_rule",
      `rule ${ruleKey} has no typed limit`,
      { ruleKey },
    );
  }
  if (value.kind === "unlimited") {
    return Object.freeze({ kind: "unlimited" });
  }
  if (value.kind !== "finite") {
    throw new PolicyCompileError(
      "invalid_rule",
      `rule ${ruleKey} has an unknown limit kind`,
      { ruleKey, kind: value.kind },
    );
  }
  const limit = value.value;
  if (
    !(
      typeof limit === "bigint"
      || (
        typeof limit === "number"
        && Number.isSafeInteger(limit)
      )
    )
  ) {
    throw new PolicyCompileError(
      "limit_out_of_range",
      `rule ${ruleKey} finite limit must be a safe integer or bigint`,
      { ruleKey, limit },
    );
  }
  const normalized = BigInt(limit);
  if (normalized < 0n || normalized > MAX_CONTROL_PLANE_LIMIT) {
    throw new PolicyCompileError(
      "limit_out_of_range",
      `rule ${ruleKey} finite limit is outside the SurrealDB int range`,
      { ruleKey, limit: normalized.toString() },
    );
  }
  return Object.freeze({ kind: "finite", value: limit });
}

function parseRule(value: unknown): ProductQuotaRule {
  if (!isRecord(value)) {
    throw new PolicyCompileError("invalid_rule", "quota rule must be an object");
  }
  const ruleKey = value.rule_key;
  if (typeof ruleKey !== "string" || ruleKey.trim().length === 0) {
    throw new PolicyCompileError(
      "invalid_rule",
      "quota rule requires a non-empty semantic rule_key",
    );
  }
  const resource = parseResource(value.resource, ruleKey);
  if (!isRecord(value.selector)) {
    throw new PolicyCompileError(
      "invalid_selector",
      `rule ${ruleKey} requires a typed selector`,
      { ruleKey },
    );
  }
  const selectorKind = value.selector.kind;
  const selectorValue = value.selector.value;
  if (
    (selectorKind !== "exact" && selectorKind !== "regex")
    || typeof selectorValue !== "string"
    || selectorValue.length === 0
  ) {
    throw new PolicyCompileError(
      "invalid_selector",
      `rule ${ruleKey} has an invalid exact/regex selector`,
      { ruleKey },
    );
  }
  if (selectorKind === "regex") validateRegex(selectorValue, ruleKey);
  if (
    typeof value.customer_label !== "string"
    || value.customer_label.trim().length === 0
  ) {
    throw new PolicyCompileError(
      "invalid_rule",
      `rule ${ruleKey} requires a customer label`,
      { ruleKey },
    );
  }
  if (
    value.customer_description !== undefined
    && typeof value.customer_description !== "string"
  ) {
    throw new PolicyCompileError(
      "invalid_rule",
      `rule ${ruleKey} customer description must be a string`,
      { ruleKey },
    );
  }
  return Object.freeze({
    rule_key: ruleKey,
    resource,
    selector: Object.freeze({
      kind: selectorKind,
      value: selectorValue,
    }),
    limit: parseLimit(value.limit, ruleKey),
    customer_label: value.customer_label,
    customer_description: value.customer_description,
  });
}

function stableRuleId(resource: NativeQuotaResource, ruleKey: string): string {
  return `q_${resource}_${stableSha256(`${resource}\0${ruleKey}`).slice(0, 20)}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateUniqueness(rules: readonly ProductQuotaRule[]): void {
  const ruleKeys = new Set<string>();
  const selectors = new Set<string>();
  for (const rule of rules) {
    const key = rule.rule_key;
    if (ruleKeys.has(key)) {
      throw new PolicyCompileError(
        "duplicate_rule_key",
        `duplicate semantic quota rule key: ${rule.rule_key}`,
        { resource: rule.resource, ruleKey: rule.rule_key },
      );
    }
    ruleKeys.add(key);

    const selector = `${rule.resource}\0${rule.selector.kind}\0${rule.selector.value}`;
    if (selectors.has(selector)) {
      throw new PolicyCompileError(
        "duplicate_selector",
        `duplicate effective quota selector for ${rule.resource}: ${rule.selector.value}`,
        {
          resource: rule.resource,
          selectorKind: rule.selector.kind,
          selectorValue: rule.selector.value,
        },
      );
    }
    selectors.add(selector);
  }
}

function validateManagedCoverage(rules: readonly ProductQuotaRule[]): void {
  for (const resource of REQUIRED_RESOURCES) {
    const fallback = rules.find((rule) =>
      rule.resource === resource
      && rule.selector.kind === "regex"
      && rule.selector.value === FALLBACK_PATTERN
      && rule.limit.kind === "unlimited"
    );
    if (!fallback) {
      throw new PolicyCompileError(
        "missing_fallback",
        `managed ${resource} quota requires an explicit .* unlimited fallback`,
        { resource },
      );
    }
    const managed = rules.find((rule) =>
      rule.resource === resource
      && rule.selector.kind === "regex"
      && rule.selector.value === MANAGED_TABLE_PATTERN
    );
    if (!managed) {
      throw new PolicyCompileError(
        "missing_managed_rule",
        `managed ${resource} quota requires an explicit ^ent_ product rule`,
        { resource },
      );
    }
  }
}

function validateRetentionPolicy(
  entitlement: ResourceEntitlementRecord,
  rules: readonly ProductQuotaRule[],
): void {
  if (entitlement.source_type !== "retention") return;
  for (const resource of REQUIRED_RESOURCES) {
    const managed = rules.find((rule) =>
      rule.resource === resource
      && rule.selector.kind === "regex"
      && rule.selector.value === MANAGED_TABLE_PATTERN
    );
    if (
      !managed
      || managed.limit.kind !== "finite"
      || BigInt(managed.limit.value) !== 0n
    ) {
      throw new PolicyCompileError(
        "invalid_retention_policy",
        `retention ${resource} rule must be a finite zero-growth limit`,
        { resource, ruleKey: managed?.rule_key },
      );
    }
  }
}

function compiledSelector(rule: ProductQuotaRule): CompiledQuotaRule["selector"] {
  return rule.selector.kind === "exact"
    ? Object.freeze({ kind: "exact", table: rule.selector.value })
    : Object.freeze({ kind: "regex", pattern: rule.selector.value });
}

function digestLimit(limit: NativeQuotaLimit): unknown {
  return limit.kind === "finite"
    ? { kind: "finite", value: limit.value.toString() }
    : { kind: "unlimited" };
}

/**
 * Pure policy compiler. It validates the complete managed coverage contract,
 * hides native DTO normalization, and returns one immutable projection whose
 * digest depends only on executable policy semantics.
 */
export function compileQuotaPolicy(
  input: CompileQuotaPolicyInput,
): CompiledQuotaPolicy {
  const productRules = (input.entitlement.rules as readonly unknown[]).map(parseRule);
  validateUniqueness(productRules);
  validateManagedCoverage(productRules);
  validateRetentionPolicy(input.entitlement, productRules);

  const pairs = productRules
    .map((rule) => {
      const ruleId = stableRuleId(rule.resource, rule.rule_key);
      const compiled: CompiledQuotaRule = Object.freeze({
        rule_id: ruleId,
        resource: rule.resource,
        selector: compiledSelector(rule),
        limit: rule.limit,
      });
      const label: CompiledQuotaRuleLabel = Object.freeze({
        rule_id: ruleId,
        rule_key: rule.rule_key,
        resource: rule.resource,
        customer_label: rule.customer_label,
        customer_description: rule.customer_description,
      });
      return { compiled, label };
    })
    .sort((left, right) =>
      compareText(left.compiled.rule_id, right.compiled.rule_id)
    );
  const rules = Object.freeze(pairs.map((pair) => pair.compiled));
  const ruleLabels = Object.freeze(pairs.map((pair) => pair.label));
  const canonicalDigest = canonicalSha256({
    format_version: 1,
    rules: rules.map((rule) => ({
      rule_id: rule.rule_id,
      resource: rule.resource,
      selector: rule.selector,
      limit: digestLimit(rule.limit),
    })),
  });

  const projection: QuotaPolicyProjectionRecord = Object.freeze({
    id: input.projection.id,
    workspace: input.entitlement.workspace,
    entitlement: input.entitlement.id,
    revision: input.projection.revision,
    compiler_version: QUOTA_POLICY_COMPILER_VERSION,
    native_capability: NATIVE_QUOTA_EXPECTED_CONTRACT.capabilityName,
    native_contract_major: NATIVE_QUOTA_EXPECTED_CONTRACT.quotaContractMajor,
    info_format_version: NATIVE_QUOTA_EXPECTED_CONTRACT.infoFormatVersion,
    rules,
    rule_labels: ruleLabels,
    canonical_digest: canonicalDigest,
    created_at: input.projection.createdAt,
    correlation_id: input.entitlement.correlation_id,
    causation_id: input.entitlement.id.toString(),
  });

  return Object.freeze({ projection, rules, ruleLabels });
}
