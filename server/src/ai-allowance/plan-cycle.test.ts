import { describe, expect, test } from "bun:test";
import {
  AI_PLAN_CYCLE_RULE_VERSION,
  AI_UPGRADE_PRORATION_RULE_VERSION,
  applyUpgradeProration,
  planCycleDirective,
  syncPlanCycleAllowance,
  type PlanCycleDirective,
} from "./plan-cycle";
import type { Queryable } from "./service";

/**
 * LCA08 周期额度规则单元回归：
 - planCycleDirective 的周期身份/事件身份推导；
 - applyUpgradeProration 的精确整数折算规格例（lca08-upgrade-proration-test-v1）；
 - syncPlanCycleAllowance 的流程语义（假件模拟账本）：AC5 试用终止标记、
   基础桶一次授予、AC6 独立补发桶幂等。账本真实语义由真实 SurrealDB
   集成测试（subscription-cascade.integration.test.ts）覆盖。
 */

const DAY_MS = 86_400_000;

function directive(overrides: Partial<PlanCycleDirective> = {}): PlanCycleDirective {
  return {
    workspaceDb: "ws_team",
    usable: true,
    baseSourceKind: "subscription",
    baseSourceId: "quota_subscription:team",
    periodKey: "subscription:quota_subscription:team:2026-09-01T00:00:00.000Z",
    cycleAllowance: 200,
    expiresAt: "2026-10-01T00:00:00.000Z",
    periodStart: "2026-09-01T00:00:00.000Z",
    eventKey: "quota_subscription_item:team_item",
    eventEffectiveAt: "2026-09-01T00:00:00.000Z",
    label: "夹具律师 Plus周期 AI 额度",
    ...overrides,
  };
}

describe("applyUpgradeProration（lca08-upgrade-proration-test-v1 折算规格）", () => {
  const den = 30 * DAY_MS; // 30 天周期

  test("30 天周期 200→350 第 15 天补 75（剩余 15/30）", () => {
    const out = applyUpgradeProration({
      highWater: 200, target: 350, rNum: 0, rDen: den, remainingMs: 15 * DAY_MS, grantedTotal: 0,
    });
    expect(out.grant).toBe(75);
    expect(out.highWater).toBe(350);
    expect(out.rNum).toBe(150 * 15 * DAY_MS);
    expect(out.grantedTotal).toBe(75);
  });

  test("仅剩 1 天补 5；周期末补 0", () => {
    const lastDay = applyUpgradeProration({
      highWater: 200, target: 350, rNum: 0, rDen: den, remainingMs: 1 * DAY_MS, grantedTotal: 0,
    });
    expect(lastDay.grant).toBe(5);
    const atEnd = applyUpgradeProration({
      highWater: 200, target: 350, rNum: 0, rDen: den, remainingMs: 0, grantedTotal: 0,
    });
    expect(atEnd.grant).toBe(0);
    expect(atEnd.highWater).toBe(350);
  });

  test("多次小数补发按累计 floor 去重，不逐事件丢失", () => {
    // 每次 (A−H)*remaining ≈ 0.97：第一次 floor=0 不发桶，第二次累计 1.93 → 补 1。
    const first = applyUpgradeProration({
      highWater: 200, target: 201, rNum: 0, rDen: den, remainingMs: 29 * DAY_MS, grantedTotal: 0,
    });
    expect(first.grant).toBe(0);
    const second = applyUpgradeProration({
      highWater: 201, target: 202, rNum: first.rNum, rDen: den,
      remainingMs: 28 * DAY_MS, grantedTotal: first.grantedTotal,
    });
    expect(second.grant).toBe(1);
  });

  test("高水位只增不减：200→350→200→350 同周期不重复领取", () => {
    const up = applyUpgradeProration({
      highWater: 200, target: 350, rNum: 0, rDen: den, remainingMs: 15 * DAY_MS, grantedTotal: 0,
    });
    expect(up.grant).toBe(75);
    // 降回 200：不高于高水位 → 0，H 不降。
    const down = applyUpgradeProration({
      highWater: up.highWater, target: 200, rNum: up.rNum, rDen: den,
      remainingMs: 10 * DAY_MS, grantedTotal: up.grantedTotal,
    });
    expect(down.grant).toBe(0);
    expect(down.highWater).toBe(350);
    // 再回 350：等于高水位 → 仍 0（只补高水位以上）。
    const again = applyUpgradeProration({
      highWater: down.highWater, target: 350, rNum: down.rNum, rDen: den,
      remainingMs: 5 * DAY_MS, grantedTotal: down.grantedTotal,
    });
    expect(again.grant).toBe(0);
    // 升到更高档 500：只补 350 以上的剩余正差额。
    const higher = applyUpgradeProration({
      highWater: again.highWater, target: 500, rNum: again.rNum, rDen: den,
      remainingMs: 5 * DAY_MS, grantedTotal: again.grantedTotal,
    });
    expect(higher.grant).toBe(25); // (500−350)*5/30 = 25
  });

  test("补发取整不回吐：累计已授予只增，负差额被 max(0) 钳制", () => {
    const out = applyUpgradeProration({
      highWater: 350, target: 200, rNum: 150 * 15 * DAY_MS, rDen: den,
      remainingMs: 10 * DAY_MS, grantedTotal: 75,
    });
    expect(out.grant).toBe(0);
    expect(out.grantedTotal).toBe(75);
    expect(out.highWater).toBe(350);
  });
});

describe("planCycleDirective（LCA08 周期身份与事件身份）", () => {
  const base = {
    baseSourceKind: "subscription" as const,
    baseSourceId: "quota_subscription:team",
    effectiveFrom: "2026-09-01T00:00:00.000Z",
    effectiveUntil: "2026-10-01T00:00:00.000Z",
    productPlanName: "夹具律师 Plus",
    features: [{ key: "ai_cycle_allowance", enabled: true, limit: 200 }],
  };
  const cycle = { cycleFrom: "2026-09-01T00:00:00.000Z", cycleUntil: "2026-10-01T00:00:00.000Z" };
  const event = { key: "quota_subscription_item:team_item", effectiveAt: "2026-09-01T00:00:00.000Z" };

  test("无来源、无窗口、未配额度或缺事件身份时返回 null", () => {
    expect(planCycleDirective("ws_team", base, cycle, event)?.cycleAllowance).toBe(200);
    expect(planCycleDirective("ws_team", { ...base, baseSourceKind: "none" }, cycle, event)).toBeNull();
    // 无订阅级周期时回退 item 窗口；item 窗口也缺 → 不授予。
    expect(planCycleDirective("ws_team", { ...base, effectiveUntil: null }, null, event)).toBeNull();
    expect(planCycleDirective(null, base, cycle, event)).toBeNull();
    expect(
      planCycleDirective("ws_team", { ...base, features: [{ key: "ai_cycle_allowance", enabled: false, limit: 200 }] }, cycle, event),
    ).toBeNull();
    expect(
      planCycleDirective("ws_team", { ...base, features: [{ key: "other", enabled: true, limit: 5 }] }, cycle, event),
    ).toBeNull();
    expect(planCycleDirective("ws_team", base, cycle, null)).toBeNull();
    expect(planCycleDirective("ws_team", base, cycle, { key: "i", effectiveAt: "" })).toBeNull();
  });

  test("周期身份取订阅级周期，周期内升级换 item 不换周期键（R2）；事件身份跟随 item", () => {
    const before = planCycleDirective("ws_team", base, cycle, event);
    expect(before?.periodKey).toBe("subscription:quota_subscription:team:2026-09-01T00:00:00.000Z");
    expect(before?.expiresAt).toBe("2026-10-01T00:00:00.000Z");

    // 周期内升级：新 item 生效于 9/24，周期键与到期边界不变，事件键/折算时点跟随新 item。
    const upgraded = planCycleDirective(
      "ws_team",
      { ...base, effectiveFrom: "2026-09-24T00:00:00.000Z" },
      cycle,
      { key: "quota_subscription_item:team_item2", effectiveAt: "2026-09-24T00:00:00.000Z" },
    );
    expect(upgraded?.periodKey).toBe(before?.periodKey);
    expect(upgraded?.expiresAt).toBe("2026-10-01T00:00:00.000Z");
    expect(upgraded?.eventKey).toBe("quota_subscription_item:team_item2");
    expect(upgraded?.eventEffectiveAt).toBe("2026-09-24T00:00:00.000Z");

    // 续期：订阅推进付费周期 → 新周期键、新到期边界。
    const renewed = planCycleDirective("ws_team", base, {
      cycleFrom: "2026-10-01T00:00:00.000Z",
      cycleUntil: "2026-11-01T00:00:00.000Z",
    }, event);
    expect(renewed?.periodKey).not.toBe(before?.periodKey);
    expect(renewed?.periodKey).toBe("subscription:quota_subscription:team:2026-10-01T00:00:00.000Z");
    expect(renewed?.expiresAt).toBe("2026-11-01T00:00:00.000Z");

    // 试用转付费：baseSourceKind 翻转即新周期键，不复活试用余额。
    const trial = planCycleDirective("ws_team", { ...base, baseSourceKind: "trial" }, cycle, event);
    expect(trial?.periodKey).not.toBe(before?.periodKey);
    expect(trial?.periodKey).toBe("trial:quota_subscription:team:2026-09-01T00:00:00.000Z");
    expect(trial?.baseSourceKind).toBe("trial");
  });

  test("订阅无周期字段时回退 item 窗口", () => {
    const fallback = planCycleDirective("ws_team", base, { cycleFrom: null, cycleUntil: null }, event);
    expect(fallback?.periodKey).toBe("subscription:quota_subscription:team:2026-09-01T00:00:00.000Z");
    expect(fallback?.expiresAt).toBe("2026-10-01T00:00:00.000Z");
    // 订阅周期与 item 窗口都缺失 → 不授予。
    expect(
      planCycleDirective("ws_team", { ...base, effectiveFrom: null, effectiveUntil: null }, { cycleFrom: null, cycleUntil: null }, event),
    ).toBeNull();
  });
});

/**
 * 轻量账本假件：按调用形状分派并维护桶/状态行/账本内存态——
 * 终止 UPDATE、基础桶创建事务、升级补发事务（语义与 042 schema 上的
 * SurrealQL 一致；真实引擎行为由集成测试覆盖）。
 */
class FakeLedger implements Queryable {
  buckets = new Map<string, { total: number; available: number; terminated_at?: unknown; period_key: string }>();
  states = new Map<string, { high_water: number; r_num: number; r_den: number; granted_total: number; events: string[] }>();
  grants: { bucket: string; amount: number; note: string }[] = [];
  conflictNext = 0;

  private key(id: unknown): string {
    return String(id);
  }

  async query(sql: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (sql.includes("UPDATE ai_allowance_bucket SET")) {
      let count = 0;
      // D3 修复后过滤条件是字面量 "trial:" 前缀（不再以新订阅 id 组前缀）。
      for (const bucket of this.buckets.values()) {
        if (bucket.period_key.startsWith("trial:") && bucket.terminated_at == null) {
          bucket.terminated_at = params.terminatedAt;
          count += 1;
        }
      }
      return [Array.from({ length: count })];
    }
    if (sql.includes("SELECT high_water, r_num, r_den, granted_total, events FROM ONLY $state")) {
      const row = this.states.get(this.key(params.state));
      return row ? [row] : [null];
    }
    if (sql.includes("SELECT total, available FROM ONLY $bucket")) {
      const row = this.buckets.get(this.key(params.bucket));
      return row ? [{ total: row.total, available: row.available }] : [null];
    }
    if (sql.includes("BEGIN")) {
      if (this.conflictNext > 0) {
        this.conflictNext -= 1;
        throw new Error("record already exists in ai_allowance_bucket");
      }
      if (sql.includes("LET $h0 =")) {
        // 升级补发事务：按状态行/基础桶内存态执行累计规则。
        const stateId = this.key(params.state);
        const baseRow = this.buckets.get(this.key(params.base));
        const row = this.states.get(stateId);
        const target = Number(params.target);
        const rDen = Number(params.rDen);
        const remMs = Number(params.remMs);
        const eventKey = String(params.eventKey);
        const h0 = row ? row.high_water : (baseRow ? baseRow.total : null);
        if (h0 != null && target > h0 && (row == null || (row.r_den === rDen && !row.events.includes(eventKey)))) {
          const num = (row?.r_num ?? 0) + (target - h0) * remMs;
          const grant = Math.max(0, Math.floor(num / rDen) - (row?.granted_total ?? 0));
          if (row) {
            row.high_water = target;
            row.r_num = num;
            row.granted_total += grant;
            row.events.push(eventKey);
          } else {
            this.states.set(stateId, {
              high_water: target, r_num: num, r_den: rDen, granted_total: grant, events: [eventKey],
            });
          }
          if (grant > 0) {
            const id = this.key(params.bucket);
            this.buckets.set(id, {
              total: grant, available: grant, period_key: String(params.period),
            });
            this.grants.push({ bucket: id, amount: grant, note: String(params.note) });
          }
        }
        return [];
      }
      if (sql.includes("LET $pre =")) {
        // 基础桶创建事务：缺桶才建，幂等。
        const id = this.key(params.bucket);
        if (!this.buckets.has(id)) {
          this.buckets.set(id, {
            total: Number(params.target), available: Number(params.target), period_key: String(params.period),
          });
          this.grants.push({ bucket: id, amount: Number(params.target), note: String(params.note) });
        }
        return [];
      }
      throw new Error(`unexpected txn in fake ledger: ${sql.slice(0, 80)}`);
    }
    throw new Error(`unexpected sql in fake ledger: ${sql.slice(0, 80)}`);
  }
}

describe("syncPlanCycleAllowance（LCA08 周期额度规则流程）", () => {
  test("新周期一次性建基础桶，重复同步幂等收敛为 none", async () => {
    const ledger = new FakeLedger();
    const created = await syncPlanCycleAllowance({ session: ledger, directive: directive(), correlationId: "c1" });
    expect(created.kind).toBe("created");
    expect(created.delta).toBe(200);
    expect(created.ruleVersion).toBe(AI_PLAN_CYCLE_RULE_VERSION);
    expect(ledger.grants).toHaveLength(1);

    const repeat = await syncPlanCycleAllowance({ session: ledger, directive: directive(), correlationId: "c2" });
    expect(repeat.kind).toBe("none");
    expect(ledger.grants).toHaveLength(1);
  });

  test("AC5：转付费同步立即终止关联旧试用桶（幂等），金额与期限不动", async () => {
    const ledger = new FakeLedger();
    ledger.buckets.set("ai_allowance_bucket:trial_old", {
      total: 100, available: 80, period_key: "trial:quota_subscription:team:2026-08-01T00:00:00.000Z",
    });
    ledger.buckets.set("ai_allowance_bucket:purchased_keep", {
      total: 50, available: 50, period_key: "purchased-2026",
    });

    const first = await syncPlanCycleAllowance({ session: ledger, directive: directive(), correlationId: "c1" });
    expect(first.trialTerminated).toBe(1);
    const trial = ledger.buckets.get("ai_allowance_bucket:trial_old")!;
    expect(trial.terminated_at).not.toBeNull();
    expect(trial.total).toBe(100);
    expect(trial.available).toBe(80);
    // 付费基础桶正常建立；购买桶不受影响。
    expect(ledger.grants).toHaveLength(1);
    expect(ledger.buckets.get("ai_allowance_bucket:purchased_keep")?.terminated_at ?? null).toBeNull();

    // 重复转换/刷新：标记幂等，不再计数，不重复授予。
    const again = await syncPlanCycleAllowance({ session: ledger, directive: directive(), correlationId: "c2" });
    expect(again.trialTerminated).toBe(0);
    expect(ledger.grants).toHaveLength(1);
  });

  test("AC5 回归（LCA-14 D3）：试用桶内嵌的是试用来源 id，与新付费 baseSourceId 不同也必须终止", async () => {
    // 生产实测场景：转付费后 directive.baseSourceId = 新付费订阅 id（q_paid），
    // 而试用桶 period_key = trial:quota_subscription:provision_ws_x:<from>。
    // 旧实现按 trial:<新订阅id>: 过滤永不匹配，残留可消费试用桶。
    const ledger = new FakeLedger();
    ledger.buckets.set("ai_allowance_bucket:trial_real", {
      total: 40, available: 28, period_key: "trial:quota_subscription:provision_ws_x:2026-10-02T07:50:00.000Z",
    });

    const outcome = await syncPlanCycleAllowance({
      session: ledger,
      directive: directive({ baseSourceId: "quota_subscription:q_paid", periodKey: "subscription:quota_subscription:q_paid:2026-10-02T08:00:00.000Z" }),
      correlationId: "convert-paid",
    });
    expect(outcome.trialTerminated).toBe(1);
    expect(ledger.buckets.get("ai_allowance_bucket:trial_real")!.terminated_at).not.toBeNull();
  });

  test("AC6：周期内升级形成独立补发桶（基础桶不动），重放与重复刷新不重授", async () => {
    const ledger = new FakeLedger();
    await syncPlanCycleAllowance({ session: ledger, directive: directive(), correlationId: "c1" });

    // 第 15 天升级到 350：剩余 15/30 → 补 75 为独立桶，基础桶保持 200。
    const upgraded = await syncPlanCycleAllowance({
      session: ledger,
      directive: directive({ cycleAllowance: 350, eventKey: "quota_subscription_item:team_item2", eventEffectiveAt: "2026-09-16T00:00:00.000Z" }),
      correlationId: "c2",
    });
    expect(upgraded.kind).toBe("supplement");
    expect(upgraded.delta).toBe(75);
    const grants = ledger.grants.map((grant) => grant.amount);
    expect(grants).toEqual([200, 75]);
    // 补发审计：grant 账本 note 携带折算规则版本、事件键与折算分子/分母。
    expect(ledger.grants[1]!.note).toContain(AI_UPGRADE_PRORATION_RULE_VERSION);
    expect(ledger.grants[1]!.note).toContain("quota_subscription_item:team_item2");
    expect(ledger.grants[1]!.note).toContain("remaining 1296000000/2592000000");
    const baseBucket = [...ledger.buckets.values()].find((b) => b.total === 200)!;
    expect(baseBucket.total).toBe(200);

    // 同一事件重放（重启/重复通知）：事件键去重，无新授予。
    const replay = await syncPlanCycleAllowance({
      session: ledger,
      directive: directive({ cycleAllowance: 350, eventKey: "quota_subscription_item:team_item2", eventEffectiveAt: "2026-09-16T00:00:00.000Z" }),
      correlationId: "c3",
    });
    expect(replay.kind).toBe("none");
    expect(ledger.grants).toHaveLength(2);
  });

  test("AC6：降级与周期末升级不补发；再升更高档只补高水位以上差额", async () => {
    const ledger = new FakeLedger();
    await syncPlanCycleAllowance({ session: ledger, directive: directive(), correlationId: "c1" });
    const up = await syncPlanCycleAllowance({
      session: ledger,
      directive: directive({ cycleAllowance: 350, eventKey: "item2", eventEffectiveAt: "2026-09-16T00:00:00.000Z" }),
      correlationId: "c2",
    });
    expect(up.kind).toBe("supplement");

    // 降回 200：不追回。
    const down = await syncPlanCycleAllowance({
      session: ledger,
      directive: directive({ cycleAllowance: 200, eventKey: "item3", eventEffectiveAt: "2026-09-20T00:00:00.000Z" }),
      correlationId: "c3",
    });
    expect(down.kind).toBe("none");
    // 周期末升级：补 0，无新桶。
    const atEnd = await syncPlanCycleAllowance({
      session: ledger,
      directive: directive({ cycleAllowance: 360, eventKey: "item4", eventEffectiveAt: "2026-10-01T00:00:00.000Z" }),
      correlationId: "c4",
    });
    expect(atEnd.kind).toBe("none");
    expect(ledger.grants).toHaveLength(2);
    // 再升 500：高水位已因周期末的 360 事件抬到 360（补 0 但 H 只增不减），
    // 只补 (500−360)×5/30 = 23.33 → 累计 floor 98 − 已授予 75 = 23。
    const higher = await syncPlanCycleAllowance({
      session: ledger,
      directive: directive({ cycleAllowance: 500, eventKey: "item5", eventEffectiveAt: "2026-09-26T00:00:00.000Z" }),
      correlationId: "c5",
    });
    expect(higher.kind).toBe("supplement");
    expect(higher.delta).toBe(23);
    expect(ledger.grants.map((grant) => grant.amount)).toEqual([200, 75, 23]);
  });

  test("到期/保留模式不授予、不补差、不触碰既有桶", async () => {
    const ledger = new FakeLedger();
    await syncPlanCycleAllowance({ session: ledger, directive: directive(), correlationId: "c1" });
    const before = new Map(ledger.buckets);

    const expired = await syncPlanCycleAllowance({ session: ledger, directive: directive({ usable: false }), correlationId: "c2" });
    expect(expired.kind).toBe("none");
    expect(ledger.buckets).toEqual(before);
    expect(ledger.grants).toHaveLength(1);
  });

  test("并发建桶冲突后按幂等收敛，不重复授予", async () => {
    const ledger = new FakeLedger();
    ledger.conflictNext = 1;
    const outcome = await syncPlanCycleAllowance({ session: ledger, directive: directive(), correlationId: "c1" });
    expect(outcome.kind).toBe("created");
    expect(ledger.grants).toHaveLength(1);
  });
});
