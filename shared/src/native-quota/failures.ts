import {
  NativeQuotaViolationSchema,
  type NativeQuotaResource,
  type NativeQuotaViolation,
} from "./contracts";
import { extractNativeQuotaError } from "./errors";

type QuotaFailureRetry = "never" | "once_if_idempotent" | "after_refresh";

export type QuotaFailureViolation = Readonly<{
  resource: NativeQuotaResource;
  table: string;
  limit?: number | bigint;
  current?: number | bigint;
  delta?: number | bigint;
  projected?: number | bigint;
  over_by?: number | bigint;
  rule_ids?: readonly string[];
}>;

type QuotaFailureBase = Readonly<{
  retry: QuotaFailureRetry;
  retryable: boolean;
  preserve_draft: boolean;
  transaction_committed: boolean | null;
}>;

export type QuotaFailure =
  | (QuotaFailureBase & Readonly<{
      kind: "exceeded";
      code: "quota_exceeded";
      retry: "never";
      retryable: false;
      preserve_draft: true;
      transaction_committed: false;
      violations: readonly QuotaFailureViolation[];
      truncated: boolean;
    }>)
  | (QuotaFailureBase & Readonly<{
      kind: "policy_changed";
      code: "quota_conflict" | "quota_policy_changed";
      retry: "once_if_idempotent";
    }>)
  | (QuotaFailureBase & Readonly<{
      kind: "ledger_unavailable";
      code: "quota_ledger_unavailable" | "quota_ledger_rebuilding";
      retry: "after_refresh";
    }>)
  | (QuotaFailureBase & Readonly<{
      kind: "generation_mismatch";
      code: "quota_generation_mismatch";
      retry: "never";
    }>)
  | (QuotaFailureBase & Readonly<{
      kind: "policy_invalid";
      code:
        | "quota_policy_invalid"
        | "quota_policy_exists"
        | "quota_policy_not_found"
        | "quota_rule_not_found";
      retry: "never";
    }>)
  | (QuotaFailureBase & Readonly<{
      kind: "incompatible";
      code: "native_quota_contract_incompatible" | "quota_backend_incompatible";
      retry: "never";
    }>)
  | Readonly<{
      kind: "unknown";
      code: "quota_unknown";
      retry: "never";
      retryable: false;
      preserve_draft: true;
      transaction_committed: null;
      message?: string;
    }>;

export type QuotaFailureViewer =
  | Readonly<{ kind: "participant"; operated_table?: string }>
  | Readonly<{ kind: "workspace_admin" }>
  | Readonly<{ kind: "operator" }>;

function violationsFromDetails(details: Record<string, unknown>): NativeQuotaViolation[] {
  if (!Array.isArray(details.violations)) return [];
  return details.violations.flatMap((violation) => {
    const parsed = NativeQuotaViolationSchema.safeParse(violation);
    return parsed.success ? [parsed.data] : [];
  });
}

function projectViolation(
  violation: NativeQuotaViolation,
  viewer: QuotaFailureViewer,
): QuotaFailureViolation | null {
  if (viewer.kind === "participant") {
    if (!viewer.operated_table || violation.table !== viewer.operated_table) {
      return null;
    }
    return {
      resource: violation.resource,
      table: violation.table,
    };
  }
  const customerSafe = {
    resource: violation.resource,
    table: violation.table,
    limit: violation.limit,
    current: violation.current,
    delta: violation.delta,
    projected: violation.projected,
    over_by: violation.over_by,
  };
  return viewer.kind === "operator"
    ? { ...customerSafe, rule_ids: violation.rule_ids }
    : customerSafe;
}

function safeUnknownMessage(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const message = error.message.trim();
  return message.length === 0 ? undefined : message.slice(0, 240);
}

/**
 * 把 HTTP/RPC/WS SDK error 映射为产品领域失败。
 * 已知 quota 分支只读结构化 envelope，绝不解析 message。
 */
export function mapQuotaFailure(
  error: unknown,
  viewer: QuotaFailureViewer,
): QuotaFailure {
  const envelope = extractNativeQuotaError(error);
  if (!envelope) {
    return {
      kind: "unknown",
      code: "quota_unknown",
      retry: "never",
      retryable: false,
      preserve_draft: true,
      transaction_committed: null,
      ...(safeUnknownMessage(error) ? { message: safeUnknownMessage(error) } : {}),
    };
  }

  if (envelope.code === "quota_exceeded") {
    return {
      kind: "exceeded",
      code: "quota_exceeded",
      retry: "never",
      retryable: false,
      preserve_draft: true,
      transaction_committed: false,
      violations: violationsFromDetails(envelope.details)
        .map((violation) => projectViolation(violation, viewer))
        .filter((violation): violation is QuotaFailureViolation => violation !== null),
      truncated: envelope.details.truncated === true,
    };
  }

  if (envelope.code === "quota_conflict" || envelope.code === "quota_policy_changed") {
    return {
      kind: "policy_changed",
      code: envelope.code,
      retry: "once_if_idempotent",
      retryable: envelope.retryable,
      preserve_draft: true,
      transaction_committed: null,
    };
  }

  if (
    envelope.code === "quota_ledger_unavailable"
    || envelope.code === "quota_ledger_rebuilding"
  ) {
    return {
      kind: "ledger_unavailable",
      code: envelope.code,
      retry: "after_refresh",
      retryable: envelope.retryable,
      preserve_draft: true,
      transaction_committed: false,
    };
  }

  if (envelope.code === "quota_generation_mismatch") {
    return {
      kind: "generation_mismatch",
      code: envelope.code,
      retry: "never",
      retryable: false,
      preserve_draft: true,
      transaction_committed: false,
    };
  }

  if (
    envelope.code === "quota_policy_invalid"
    || envelope.code === "quota_policy_exists"
    || envelope.code === "quota_policy_not_found"
    || envelope.code === "quota_rule_not_found"
  ) {
    return {
      kind: "policy_invalid",
      code: envelope.code,
      retry: "never",
      retryable: false,
      preserve_draft: true,
      transaction_committed: false,
    };
  }

  if (
    envelope.code === "native_quota_contract_incompatible"
    || envelope.code === "quota_backend_incompatible"
  ) {
    return {
      kind: "incompatible",
      code: envelope.code,
      retry: "never",
      retryable: false,
      preserve_draft: true,
      transaction_committed: false,
    };
  }

  return {
    kind: "unknown",
    code: "quota_unknown",
    retry: "never",
    retryable: false,
    preserve_draft: true,
    transaction_committed: null,
  };
}

export function shouldRetryQuotaFailure(
  failure: QuotaFailure,
  input: Readonly<{ idempotent: boolean; previous_retries: number }>,
): boolean {
  return failure.retry === "once_if_idempotent"
    && input.idempotent
    && input.previous_retries < 1;
}
