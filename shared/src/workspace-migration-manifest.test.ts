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
      }),
    ).toEqual({ kind: "eligible" });
  });

  test("legacy cleanup requires native-quota capability and native_verified state", () => {
    expect(WORKSPACE_MIGRATION_REQUIREMENTS[21]?.requires_engine_capability).toBe(
      NATIVE_QUOTA_EXPECTED_CONTRACT.capabilityName,
    );

    expect(
      evaluateWorkspaceMigrationEligibility(21, {
        engineCapabilities: [NATIVE_QUOTA_EXPECTED_CONTRACT.capabilityName],
        quotaMigrationState: "not_started",
      }).kind,
    ).toBe("blocked");

    expect(
      evaluateWorkspaceMigrationEligibility(21, {
        engineCapabilities: [],
        quotaMigrationState: "native_verified",
      }).kind,
    ).toBe("blocked");

    expect(
      evaluateWorkspaceMigrationEligibility(21, {
        engineCapabilities: [NATIVE_QUOTA_EXPECTED_CONTRACT.capabilityName],
        quotaMigrationState: "native_verified",
      }),
    ).toEqual({ kind: "eligible" });
  });

  test("selectContinuousEligibleMigrations stops before the first blocked version", () => {
    const pending = [19, 20, 21, 22].map((version) => ({
      version,
      name: String(version),
    }));
    const result = selectContinuousEligibleMigrations(pending, {
      engineCapabilities: [NATIVE_QUOTA_EXPECTED_CONTRACT.capabilityName],
      quotaMigrationState: "not_started",
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
      }),
    ).toEqual({ kind: "eligible" });
  });
});
