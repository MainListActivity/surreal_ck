import { expect, test } from "bun:test";
import { aiAllowancePlanPrefix, aiAllowanceConsumptionReason } from "./ai-allowance";

test("三端可消费规则：来源、有效窗口、终止、暂停与独立加量/补偿", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  const source = { kind: "subscription" as const, sourceId: "quota_subscription:paid", effectiveFrom: "2026-10-01T00:00:00Z", effectiveUntil: "2026-11-01T00:00:00Z" };
  const prefix = aiAllowancePlanPrefix(source, now);
  const base = { kind: "plan_cycle", status: "active", period_key: `${prefix}cycle`, effective_from: source.effectiveFrom, expires_at: source.effectiveUntil };
  expect(aiAllowanceConsumptionReason(base, prefix, now)).toBe("available");
  expect(aiAllowanceConsumptionReason({ ...base, period_key: "trial:quota_subscription:old:cycle" }, prefix, now)).toBe("source_mismatch");
  expect(aiAllowanceConsumptionReason({ ...base, terminated_at: source.effectiveFrom }, prefix, now)).toBe("terminated");
  expect(aiAllowanceConsumptionReason({ ...base, status: "suspended" }, prefix, now)).toBe("suspended");
  expect(aiAllowanceConsumptionReason({ ...base, effective_from: "2026-10-03T00:00:00Z" }, prefix, now)).toBe("pending");
  expect(aiAllowanceConsumptionReason({ ...base, expires_at: "2026-10-02T12:00:00Z" }, prefix, now)).toBe("expired");
  expect(aiAllowanceConsumptionReason({ ...base, effective_from: "bad" }, prefix, now)).toBe("invalid");
  expect(aiAllowanceConsumptionReason({ ...base, status: "unknown" }, prefix, now)).toBe("invalid");
  for (const kind of ["purchased", "compensation"]) {
    expect(aiAllowanceConsumptionReason({ ...base, kind }, null, now)).toBe("available");
    expect(aiAllowanceConsumptionReason({ ...base, kind, effective_from: "2026-10-03T00:00:00Z" }, null, now)).toBe("pending");
  }
  for (const input of [null, { ...source, kind: "none" as const }, { ...source, effectiveFrom: "bad" },
    { ...source, effectiveFrom: "2026-10-03T00:00:00Z" }, { ...source, effectiveUntil: "2026-10-02T12:00:00Z" }]) {
    expect(aiAllowancePlanPrefix(input, now)).toBeNull();
  }
});
