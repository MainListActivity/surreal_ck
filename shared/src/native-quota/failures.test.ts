import { describe, expect, test } from "bun:test";
import { mapQuotaFailure, shouldRetryQuotaFailure } from "./failures";

function quotaError(code: string, retryable: boolean, details: Record<string, unknown> = {}) {
  return Object.assign(new Error("wording must not affect mapping"), {
    kind: "Quota",
    details: { code, retryable, details },
  });
}

describe("quota failure mapping", () => {
  test("keeps admin exceeded details but removes native rule ids", () => {
    const failure = mapQuotaFailure(
      quotaError("quota_exceeded", false, {
        truncated: false,
        violations: [{
          resource: "record",
          table: "ent_case",
          rule_ids: ["native-secret-rule"],
          limit: 10,
          current: 10,
          delta: 1,
          projected: 11,
          over_by: 1,
        }],
      }),
      { kind: "workspace_admin" },
    );

    expect(failure).toEqual({
      kind: "exceeded",
      code: "quota_exceeded",
      retry: "never",
      retryable: false,
      preserve_draft: true,
      transaction_committed: false,
      truncated: false,
      violations: [{
        resource: "record",
        table: "ent_case",
        limit: 10,
        current: 10,
        delta: 1,
        projected: 11,
        over_by: 1,
      }],
    });
  });

  test("participant sees only the operated table and no total usage", () => {
    const failure = mapQuotaFailure(
      quotaError("quota_exceeded", false, {
        violations: [
          {
            resource: "record",
            table: "ent_case",
            rule_ids: ["a"],
            limit: 10,
            current: 10,
            delta: 1,
            projected: 11,
            over_by: 1,
          },
          {
            resource: "field",
            table: "private_table",
            rule_ids: ["b"],
            limit: 2,
            current: 2,
            delta: 1,
            projected: 3,
            over_by: 1,
          },
        ],
      }),
      { kind: "participant", operated_table: "ent_case" },
    );

    expect(failure.kind).toBe("exceeded");
    if (failure.kind !== "exceeded") throw new Error("expected exceeded");
    expect(failure.violations).toEqual([{ resource: "record", table: "ent_case" }]);
  });

  test("participant context without an operated table reveals no table identity", () => {
    const failure = mapQuotaFailure(
      quotaError("quota_exceeded", false, {
        violations: [{
          resource: "record",
          table: "private_table",
          rule_ids: ["secret"],
          limit: 1,
          current: 1,
          delta: 1,
          projected: 2,
          over_by: 1,
        }],
      }),
      { kind: "participant" },
    );
    expect(failure.kind).toBe("exceeded");
    if (failure.kind !== "exceeded") throw new Error("expected exceeded");
    expect(failure.violations).toEqual([]);
  });

  test("operator keeps native rule ids for diagnosis", () => {
    const failure = mapQuotaFailure(
      quotaError("quota_exceeded", false, {
        violations: [{
          resource: "table",
          table: "ent_case",
          rule_ids: ["table/all"],
          limit: 1,
          current: 1,
          delta: 1,
          projected: 2,
          over_by: 1,
        }],
      }),
      { kind: "operator" },
    );

    expect(failure.kind).toBe("exceeded");
    if (failure.kind !== "exceeded") throw new Error("expected exceeded");
    expect(failure.violations[0]?.rule_ids).toEqual(["table/all"]);
  });

  test("retries policy changes at most once and only for proven idempotent operations", () => {
    const failure = mapQuotaFailure(
      quotaError("quota_policy_changed", true),
      { kind: "workspace_admin" },
    );

    expect(shouldRetryQuotaFailure(failure, {
      idempotent: true,
      previous_retries: 0,
    })).toBe(true);
    expect(shouldRetryQuotaFailure(failure, {
      idempotent: true,
      previous_retries: 1,
    })).toBe(false);
    expect(shouldRetryQuotaFailure(failure, {
      idempotent: false,
      previous_retries: 0,
    })).toBe(false);
  });

  test("does not infer a known failure from an error message", () => {
    const failure = mapQuotaFailure(
      new Error("quota_exceeded quota_policy_changed"),
      { kind: "workspace_admin" },
    );
    expect(failure).toMatchObject({
      kind: "unknown",
      code: "quota_unknown",
      retry: "never",
    });
  });
});
