import { describe, expect, test } from "bun:test";
import { NATIVE_QUOTA_EXPECTED_CONTRACT } from "./native-quota/compatibility";
import {
  evaluateWorkspaceMigrationEligibility,
  selectContinuousEligibleMigrations,
  WORKSPACE_MIGRATION_REQUIREMENTS,
} from "./workspace-migration-manifest";

describe("workspace migration manifest", () => {
  test("ungated versions are always eligible", () => {
    expect(
      evaluateWorkspaceMigrationEligibility(20, {
        engineCapabilities: [],
        quotaMigrationState: "not_started",
        legacyCleanupEligible: false,
      }),
    ).toEqual({ kind: "eligible" });
  });

  test("legacy cleanup requires native capability, native_verified, and elapsed stability window", () => {
    expect(WORKSPACE_MIGRATION_REQUIREMENTS[21]?.requires_engine_capability).toBe(
      NATIVE_QUOTA_EXPECTED_CONTRACT.capabilityName,
    );

    expect(
      evaluateWorkspaceMigrationEligibility(21, {
        engineCapabilities: [NATIVE_QUOTA_EXPECTED_CONTRACT.capabilityName],
        quotaMigrationState: "not_started",
        legacyCleanupEligible: false,
      }).kind,
    ).toBe("blocked");

    expect(
      evaluateWorkspaceMigrationEligibility(21, {
        engineCapabilities: [],
        quotaMigrationState: "native_verified",
        legacyCleanupEligible: true,
      }).kind,
    ).toBe("blocked");

    expect(
      evaluateWorkspaceMigrationEligibility(21, {
        engineCapabilities: [NATIVE_QUOTA_EXPECTED_CONTRACT.capabilityName],
        quotaMigrationState: "native_verified",
        legacyCleanupEligible: false,
      }),
    ).toMatchObject({
      kind: "blocked",
      reason: "legacy_cleanup_window",
    });

    expect(
      evaluateWorkspaceMigrationEligibility(21, {
        engineCapabilities: [NATIVE_QUOTA_EXPECTED_CONTRACT.capabilityName],
        quotaMigrationState: "native_verified",
        legacyCleanupEligible: true,
      }),
    ).toEqual({ kind: "eligible" });
  });

  test("residual guard sweep only runs once legacy quota tables are gone", () => {
    // 39 门控：native_verified（021 即将在同一批先跑）或 cleanup_done 才放行；
    // legacy 在线状态下绝不移除仍在执行配额的 guard。
    for (const state of ["not_started", "native_applied", "native_policy_active"] as const) {
      expect(
        evaluateWorkspaceMigrationEligibility(39, {
          engineCapabilities: [NATIVE_QUOTA_EXPECTED_CONTRACT.capabilityName],
          quotaMigrationState: state,
          legacyCleanupEligible: true,
        }).kind,
      ).toBe("blocked");
    }
    for (const state of ["native_verified", "cleanup_done"] as const) {
      expect(
        evaluateWorkspaceMigrationEligibility(39, {
          engineCapabilities: [],
          quotaMigrationState: state,
          legacyCleanupEligible: false,
        }),
      ).toEqual({ kind: "eligible" });
    }
  });

  test("selectContinuousEligibleMigrations stops before the first blocked version", () => {
    const pending = [19, 20, 21, 22].map((version) => ({
      version,
      name: String(version),
    }));
    const result = selectContinuousEligibleMigrations(pending, {
      engineCapabilities: [NATIVE_QUOTA_EXPECTED_CONTRACT.capabilityName],
      quotaMigrationState: "not_started",
      legacyCleanupEligible: false,
    });

    expect(result.eligible.map((item) => item.version)).toEqual([19, 20]);
    expect(result.blocked?.version).toBe(21);
    expect(result.blocked?.eligibility.reason).toBe("quota_migration_state");
  });

  test("cleanup_done remains eligible so cleanup is restart-safe", () => {
    expect(
      evaluateWorkspaceMigrationEligibility(21, {
        engineCapabilities: [NATIVE_QUOTA_EXPECTED_CONTRACT.capabilityName],
        quotaMigrationState: "cleanup_done",
        legacyCleanupEligible: false,
      }),
    ).toEqual({ kind: "eligible" });
  });
});
