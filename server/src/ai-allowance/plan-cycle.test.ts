import { describe, expect, test } from "bun:test";
import {
  AI_PLAN_CYCLE_RULE_VERSION,
  planCycleDirective,
  syncPlanCycleAllowance,
  type PlanCycleDirective,
} from "./plan-cycle";
import type { Queryable } from "./service";

/**
 * 轻量账本假件：按调用形状分派——裸 SELECT 读桶状态；BEGIN 事务脚本按
 * 状态执行 create/topup/none 分支（含失败注入），验证重试后收敛。
 */
class FakeLedger implements Queryable {
  bucket: { total: number; available: number } | null = null;
  grants: { amount: number; note: string }[] = [];
  failNextTx = 0;
  conflictNext = 0;

  async query(sql: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (sql.includes("BEGIN")) {
      if (this.conflictNext > 0) {
        this.conflictNext -= 1;
        throw new Error("record already exists in ai_allowance_bucket");
      }
      if (this.failNextTx > 0) {
        this.failNextTx -= 1;
        throw new Error("flaky storage");
      }
      const target = Number(params.target);
      if (this.bucket === null) {
        this.bucket = { total: target, available: target };
        this.grants.push({ amount: target, note: String(params.note) });
        return [];
      }
      const delta = target - this.bucket.total;
      if (delta > 0) {
        this.bucket = { total: target, available: this.bucket.available + delta };
        this.grants.push({ amount: delta, note: String(params.note) });
      }
      return [];
    }
    if (sql.includes("SELECT total, available FROM ONLY $bucket")) {
      return this.bucket ?? null;
    }
    throw new Error(`unexpected sql in fake ledger: ${sql.slice(0, 80)}`);
  }
}

function directive(overrides: Partial<PlanCycleDirective> = {}): PlanCycleDirective {
  return {
    workspaceDb: "ws_team",
    usable: true,
    periodKey: "quota_subscription:team:2026-09-01T00:00:00.000Z",
    cycleAllowance: 200,
    expiresAt: "2026-10-01T00:00:00.000Z",
    periodStart: "2026-09-01T00:00:00.000Z",
    label: "夹具律师 Plus周期 AI 额度",
    ...overrides,
  };
}

describe("syncPlanCycleAllowance（LCA08 周期额度规则）", () => {
  test("新周期建桶并记 grant 账，重复同步幂等收敛为 none", async () => {
    const ledger = new FakeLedger();
    const session: Queryable = ledger;

    const created = await syncPlanCycleAllowance({ session, directive: directive(), correlationId: "c1" });
    expect(created.kind).toBe("created");
    expect(created.delta).toBe(200);
    expect(created.ruleVersion).toBe(AI_PLAN_CYCLE_RULE_VERSION);
    expect(ledger.bucket).toEqual({ total: 200, available: 200 });
    expect(ledger.grants).toHaveLength(1);

    const repeat = await syncPlanCycleAllowance({ session, directive: directive(), correlationId: "c2" });
    expect(repeat.kind).toBe("none");
    expect(ledger.bucket).toEqual({ total: 200, available: 200 });
    expect(ledger.grants).toHaveLength(1);
  });

  test("周期内升级只补发正差额，桶到期边界不变", async () => {
    const ledger = new FakeLedger();
    const session: Queryable = ledger;
    await syncPlanCycleAllowance({ session, directive: directive({ cycleAllowance: 120 }), correlationId: "c1" });

    const upgraded = await syncPlanCycleAllowance({ session, directive: directive({ cycleAllowance: 200 }), correlationId: "c2" });
    expect(upgraded.kind).toBe("topup");
    expect(upgraded.delta).toBe(80);
    expect(ledger.bucket).toEqual({ total: 200, available: 200 });
    expect(ledger.grants.map((grant) => grant.amount)).toEqual([120, 80]);

    const repeat = await syncPlanCycleAllowance({ session, directive: directive({ cycleAllowance: 200 }), correlationId: "c3" });
    expect(repeat.kind).toBe("none");
    expect(ledger.grants).toHaveLength(2);
  });

  test("降级不追回已授予额度", async () => {
    const ledger = new FakeLedger();
    await syncPlanCycleAllowance({ session: ledger, directive: directive({ cycleAllowance: 200 }), correlationId: "c1" });
    const downgraded = await syncPlanCycleAllowance({ session: ledger, directive: directive({ cycleAllowance: 120 }), correlationId: "c2" });
    expect(downgraded.kind).toBe("none");
    expect(ledger.bucket).toEqual({ total: 200, available: 200 });
    expect(ledger.grants).toHaveLength(1);
  });

  test("到期/保留模式不授予、不补差、不触碰既有桶", async () => {
    const ledger = new FakeLedger();
    await syncPlanCycleAllowance({ session: ledger, directive: directive(), correlationId: "c1" });
    const before = { ...ledger.bucket! };

    const expired = await syncPlanCycleAllowance({ session: ledger, directive: directive({ usable: false }), correlationId: "c2" });
    expect(expired.kind).toBe("none");
    expect(ledger.bucket).toEqual(before);
    expect(ledger.grants).toHaveLength(1);
  });

  test("planCycleDirective：无来源、无窗口或计划未配额度时返回 null", () => {
    const base = {
      baseSourceKind: "subscription" as const,
      baseSourceId: "quota_subscription:team",
      effectiveFrom: "2026-09-01T00:00:00.000Z",
      effectiveUntil: "2026-10-01T00:00:00.000Z",
      productPlanName: "夹具律师 Plus",
      features: [{ key: "ai_cycle_allowance", enabled: true, limit: 200 }],
    };
    expect(planCycleDirective("ws_team", base)?.cycleAllowance).toBe(200);
    expect(planCycleDirective("ws_team", { ...base, baseSourceKind: "none" })).toBeNull();
    expect(planCycleDirective("ws_team", { ...base, effectiveUntil: null })).toBeNull();
    expect(planCycleDirective(null, base)).toBeNull();
    expect(
      planCycleDirective("ws_team", { ...base, features: [{ key: "ai_cycle_allowance", enabled: false, limit: 200 }] }),
    ).toBeNull();
    expect(
      planCycleDirective("ws_team", { ...base, features: [{ key: "other", enabled: true, limit: 5 }] }),
    ).toBeNull();
  });

  test("并发建桶冲突后按幂等收敛，不重复授予", async () => {
    const ledger = new FakeLedger();
    ledger.conflictNext = 1;
    const outcome = await syncPlanCycleAllowance({ session: ledger, directive: directive(), correlationId: "c1" });
    expect(outcome.kind).toBe("created");
    expect(ledger.grants).toHaveLength(1);
    expect(ledger.bucket).toEqual({ total: 200, available: 200 });
  });
});
