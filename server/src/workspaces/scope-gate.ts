import type { WorkspaceQuotaMigrationState } from "@surreal-ck/shared/workspace-migration-manifest";
import type { DateTime, StringRecordId } from "surrealdb";

/** Default freshness window for native audit before re-issuing scope. */
export const DEFAULT_NATIVE_AUDIT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type WorkspaceScopeGateSnapshot = Readonly<{
  status: string;
  desiredEntitlement?: StringRecordId | string | null;
  appliedEntitlement?: StringRecordId | string | null;
  desiredQuotaProjection?: StringRecordId | string | null;
  appliedQuotaProjection?: StringRecordId | string | null;
  ledgerState?: string | null;
  usageTrusted?: boolean | null;
  lastNativeAuditAt?: DateTime | Date | string | null;
  quotaMigrationState?: WorkspaceQuotaMigrationState | string | null;
}>;

export type WorkspaceScopeGateDenial =
  | "not_active"
  | "entitlement_out_of_sync"
  | "projection_out_of_sync"
  | "ledger_untrusted"
  | "native_audit_stale"
  | "native_audit_missing";

export type WorkspaceScopeGateResult =
  | { ok: true }
  | { ok: false; reason: WorkspaceScopeGateDenial; details?: Readonly<Record<string, unknown>> };

function idKey(value: StringRecordId | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : value.toString();
}

function auditTimestampMs(value: DateTime | Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  if (value instanceof Date) return value.getTime();
  // surrealdb DateTime
  if (typeof value === "object" && value !== null && "toJSON" in value) {
    const iso = (value as { toJSON(): string }).toJSON();
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "object" && value !== null && "nanoseconds" in value) {
    const ns = (value as { nanoseconds: bigint }).nanoseconds;
    return Number(ns / 1_000_000n);
  }
  return null;
}

/**
 * Shared gate for IdP default-scope, switch-workspace, and post-create scope
 * issuance. Fail closed unless the workspace is active, desired/applied
 * pointers match, the ledger is trusted, and the last native audit is fresh.
 */
export function evaluateWorkspaceScopeGate(
  snapshot: WorkspaceScopeGateSnapshot,
  options: Readonly<{
    now?: Date;
    maxAuditAgeMs?: number;
  }> = {},
): WorkspaceScopeGateResult {
  if (snapshot.status !== "active") {
    return {
      ok: false,
      reason: "not_active",
      details: { status: snapshot.status },
    };
  }

  const desiredEntitlement = idKey(snapshot.desiredEntitlement);
  const appliedEntitlement = idKey(snapshot.appliedEntitlement);
  if (
    !desiredEntitlement
    || !appliedEntitlement
    || desiredEntitlement !== appliedEntitlement
  ) {
    return {
      ok: false,
      reason: "entitlement_out_of_sync",
      details: {
        desired: desiredEntitlement,
        applied: appliedEntitlement,
      },
    };
  }

  const desiredProjection = idKey(snapshot.desiredQuotaProjection);
  const appliedProjection = idKey(snapshot.appliedQuotaProjection);
  if (
    !desiredProjection
    || !appliedProjection
    || desiredProjection !== appliedProjection
  ) {
    return {
      ok: false,
      reason: "projection_out_of_sync",
      details: {
        desired: desiredProjection,
        applied: appliedProjection,
      },
    };
  }

  if (snapshot.ledgerState !== "ready" || snapshot.usageTrusted !== true) {
    return {
      ok: false,
      reason: "ledger_untrusted",
      details: {
        ledgerState: snapshot.ledgerState ?? null,
        usageTrusted: snapshot.usageTrusted ?? null,
      },
    };
  }

  const auditMs = auditTimestampMs(snapshot.lastNativeAuditAt);
  if (auditMs === null) {
    return { ok: false, reason: "native_audit_missing" };
  }

  const now = options.now ?? new Date();
  const maxAge = options.maxAuditAgeMs ?? DEFAULT_NATIVE_AUDIT_MAX_AGE_MS;
  if (now.getTime() - auditMs > maxAge) {
    return {
      ok: false,
      reason: "native_audit_stale",
      details: {
        lastNativeAuditAt: new Date(auditMs).toISOString(),
        maxAuditAgeMs: maxAge,
      },
    };
  }

  return { ok: true };
}
