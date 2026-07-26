import { describe, expect, test } from "bun:test";
import { StringRecordId } from "surrealdb";
import {
  DEFAULT_NATIVE_AUDIT_MAX_AGE_MS,
  evaluateWorkspaceScopeGate,
} from "./scope-gate";

function eligibleSnapshot(
  overrides: Partial<Parameters<typeof evaluateWorkspaceScopeGate>[0]> = {},
) {
  return {
    status: "active",
    desiredEntitlement: new StringRecordId("resource_entitlement:v1"),
    appliedEntitlement: new StringRecordId("resource_entitlement:v1"),
    desiredQuotaProjection: new StringRecordId("quota_policy_projection:v1"),
    appliedQuotaProjection: new StringRecordId("quota_policy_projection:v1"),
    ledgerState: "ready",
    usageTrusted: true,
    lastNativeAuditAt: new Date("2026-07-26T12:00:00.000Z"),
    quotaMigrationState: "native_verified",
    ...overrides,
  };
}

describe("evaluateWorkspaceScopeGate", () => {
  test("allows active workspaces with matching pointers, trusted ledger, and fresh audit", () => {
    expect(
      evaluateWorkspaceScopeGate(eligibleSnapshot(), {
        now: new Date("2026-07-26T12:30:00.000Z"),
      }),
    ).toEqual({ ok: true });
  });

  test("rejects provisioning and provisioning_error workspaces", () => {
    for (const status of ["provisioning", "provisioning_error", "failed", "archived"]) {
      const result = evaluateWorkspaceScopeGate(eligibleSnapshot({ status }));
      expect(result).toEqual({
        ok: false,
        reason: "not_active",
        details: { status },
      });
    }
  });

  test("rejects mismatched desired/applied entitlement or projection", () => {
    expect(
      evaluateWorkspaceScopeGate(
        eligibleSnapshot({
          appliedEntitlement: new StringRecordId("resource_entitlement:old"),
        }),
      ).reason,
    ).toBe("entitlement_out_of_sync");

    expect(
      evaluateWorkspaceScopeGate(
        eligibleSnapshot({
          appliedQuotaProjection: null,
        }),
      ).reason,
    ).toBe("projection_out_of_sync");
  });

  test("rejects untrusted ledger", () => {
    expect(
      evaluateWorkspaceScopeGate(
        eligibleSnapshot({ ledgerState: "rebuilding", usageTrusted: false }),
      ).reason,
    ).toBe("ledger_untrusted");

    expect(
      evaluateWorkspaceScopeGate(
        eligibleSnapshot({ ledgerState: "ready", usageTrusted: false }),
      ).reason,
    ).toBe("ledger_untrusted");
  });

  test("rejects missing or stale native audit", () => {
    expect(
      evaluateWorkspaceScopeGate(
        eligibleSnapshot({ lastNativeAuditAt: null }),
      ).reason,
    ).toBe("native_audit_missing");

    const stale = evaluateWorkspaceScopeGate(eligibleSnapshot(), {
      now: new Date(
        Date.parse("2026-07-26T12:00:00.000Z") + DEFAULT_NATIVE_AUDIT_MAX_AGE_MS + 1,
      ),
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("expected denial");
    expect(stale.reason).toBe("native_audit_stale");
  });
});
