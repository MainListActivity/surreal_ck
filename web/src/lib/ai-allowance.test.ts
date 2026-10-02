import { describe, expect, test } from "bun:test";
import {
  aiAllowanceBucketStatusLabel,
  aiAllowanceLedgerKindLabels,
  aiAllowanceLedgerSign,
  formatAllowanceTime,
  loadAiAllowanceSnapshot,
} from "./ai-allowance";

/** 按 SQL 里的表名分发假行，模拟成员直连查询。 */
function fakeConn(rows: Record<string, Array<Record<string, unknown>>>) {
  const queries: string[] = [];
  return {
    queries,
    async query<T = unknown>(sql: string, _params?: Record<string, unknown>): Promise<T[]> {
      queries.push(sql);
      for (const table of Object.keys(rows)) {
        if (sql.includes(`FROM ${table}`)) return rows[table] as T[];
      }
      return [] as T[];
    },
  };
}

describe("LCA05 AI 额度快照与展示", () => {
  test("聚合可用 / 预留 / 暂停 / 已过期余额并带出消费记录", async () => {
    const now = Date.now();
    const conn = fakeConn({
      ai_rate_card: [
        { id: "ai_rate_card:research_test_v1", amount: 5, revision: 1, revision_label: "test-rate-v1", tier_label: "快速 AI 回答（测试费率）" },
      ],
      ai_allowance_bucket: [
        {
          id: "ai_allowance_bucket:active", kind: "plan_cycle", label: "月度套餐",
          period_key: "2026-09", total: 100, available: 60, reserved: 10, settled: 30,
          status: "active",
          effective_from: new Date(now - 86400_000).toISOString(),
          expires_at: new Date(now + 86400_000).toISOString(),
        },
        {
          id: "ai_allowance_bucket:paused", kind: "purchased", label: "加量包",
          period_key: "2026-09", total: 50, available: 20, reserved: 5, settled: 25,
          status: "suspended",
          effective_from: new Date(now - 86400_000).toISOString(),
          expires_at: new Date(now + 86400_000).toISOString(),
        },
        {
          id: "ai_allowance_bucket:stale", kind: "plan_cycle", label: "上月套餐",
          period_key: "2026-08", total: 100, available: 15, reserved: 0, settled: 85,
          status: "active",
          effective_from: new Date(now - 30 * 86400_000).toISOString(),
          expires_at: new Date(now - 86400_000).toISOString(),
        },
      ],
      ai_ledger_entry: [
        { id: "ai_ledger_entry:e2", kind: "settle", amount: 5, note: "research run", created_at: new Date(now - 60_000).toISOString() },
        { id: "ai_ledger_entry:e1", kind: "grant", amount: 100, note: "", created_at: new Date(now - 120_000).toISOString() },
      ],
      ai_allowance_notice: [
        { id: "ai_allowance_notice:n1", period_key: "2026-09", threshold: 50, message: "AI 额度已用过半", created_at: new Date(now - 30_000).toISOString() },
      ],
    });

    const snapshot = await loadAiAllowanceSnapshot(conn);
    expect(snapshot.metered).toBe(true);
    expect(snapshot.quote).toMatchObject({ amount: 5, revisionLabel: "test-rate-v1" });
    expect(snapshot.available).toBe(60);
    expect(snapshot.reserved).toBe(10);
    // 暂停桶的 available+reserved 全部计入"暂停"，到期桶计入"已过期"
    expect(snapshot.suspended).toBe(25);
    expect(snapshot.terminated).toBe(0);
    expect(snapshot.expired).toBe(15);
    expect(snapshot.entries.map((entry) => entry.kind)).toEqual(["settle", "grant"]);
    expect(snapshot.notices[0]?.message).toBe("AI 额度已用过半");
  });

  test("无费率卡时 metered=false 且 quote 为空", async () => {
    const conn = fakeConn({ ai_rate_card: [], ai_allowance_bucket: [], ai_ledger_entry: [], ai_allowance_notice: [] });
    const snapshot = await loadAiAllowanceSnapshot(conn);
    expect(snapshot.metered).toBe(false);
    expect(snapshot.quote).toBeNull();
    expect(snapshot.available + snapshot.reserved + snapshot.suspended + snapshot.expired).toBe(0);
  });

  test("账本条目方向与类别标签稳定", () => {
    expect(aiAllowanceLedgerSign("grant")).toBe("+");
    expect(aiAllowanceLedgerSign("release")).toBe("+");
    expect(aiAllowanceLedgerSign("reserve")).toBe("-");
    expect(aiAllowanceLedgerSign("settle")).toBe("-");
    expect(aiAllowanceLedgerSign("expire")).toBe("-");
    expect(aiAllowanceLedgerSign("writeoff")).toBe("-");
    expect(aiAllowanceLedgerKindLabels.settle).toBe("结算");
  });

  test("桶状态标签：已过期 > 已终止 > 已暂停 > 生效中", () => {
    expect(aiAllowanceBucketStatusLabel({ expired: true, status: "suspended", terminated: true })).toBe("已过期");
    expect(aiAllowanceBucketStatusLabel({ expired: true, status: "suspended", terminated: false })).toBe("已过期");
    expect(aiAllowanceBucketStatusLabel({ expired: false, status: "active", terminated: true })).toBe("已终止");
    expect(aiAllowanceBucketStatusLabel({ expired: false, status: "suspended", terminated: false })).toBe("已暂停");
    expect(aiAllowanceBucketStatusLabel({ expired: false, status: "active", terminated: false })).toBe("生效中");
  });

  test("LCA08：已终止桶（试用转付费）离开可消费余额，计入 terminated", async () => {
    const now = Date.now();
    const conn = fakeConn({
      ai_rate_card: [
        { id: "ai_rate_card:research_test_v1", amount: 5, revision: 1, revision_label: "test-rate-v1", tier_label: "t" },
      ],
      ai_allowance_bucket: [
        {
          id: "ai_allowance_bucket:trial_old", kind: "plan_cycle", label: "旧试用",
          period_key: "trial:sub:2026-09", total: 40, available: 30, reserved: 0, settled: 10,
          status: "active", terminated_at: new Date(now - 60_000).toISOString(),
          effective_from: new Date(now - 86400_000).toISOString(),
          expires_at: new Date(now + 86400_000).toISOString(),
        },
        {
          id: "ai_allowance_bucket:paid_new", kind: "plan_cycle", label: "付费周期",
          period_key: "subscription:sub:2026-09", total: 200, available: 200, reserved: 0, settled: 0,
          status: "active",
          effective_from: new Date(now - 60_000).toISOString(),
          expires_at: new Date(now + 86400_000).toISOString(),
        },
      ],
      ai_ledger_entry: [],
      ai_allowance_notice: [],
    });
    const snapshot = await loadAiAllowanceSnapshot(conn);
    expect(snapshot.available).toBe(200);
    expect(snapshot.terminated).toBe(30);
    expect(snapshot.expired).toBe(0);
  });

  test("LCA-14 D2：plan_cycle 桶按当前商业来源前缀门禁过滤（与服务端 reserve 同口径）", async () => {
    const now = Date.now();
    const conn = fakeConn({
      ai_rate_card: [
        { id: "ai_rate_card:research_test_v1", amount: 5, revision: 1, revision_label: "t", tier_label: "t" },
      ],
      ai_allowance_bucket: [
        // 生产实测场景：转付费后残留 trial 桶（terminated_at 尚未落库）
        {
          id: "ai_allowance_bucket:trial", kind: "plan_cycle", label: "试用",
          period_key: "trial:quota_subscription:provision_ws_x:2026-10-02T07:50:00.000Z",
          total: 40, available: 28, reserved: 0, settled: 12, status: "active",
          effective_from: new Date(now - 3600_000).toISOString(),
          expires_at: new Date(now + 86400_000).toISOString(),
        },
        {
          id: "ai_allowance_bucket:paid", kind: "plan_cycle", label: "付费",
          period_key: "subscription:quota_subscription:q_paid:2026-10-02T08:00:00.000Z",
          total: 100, available: 100, reserved: 0, settled: 0, status: "active",
          effective_from: new Date(now - 3600_000).toISOString(),
          expires_at: new Date(now + 86400_000).toISOString(),
        },
        {
          id: "ai_allowance_bucket:topup", kind: "purchased", label: "加量",
          period_key: "purchased-2026-10", total: 50, available: 50, reserved: 0, settled: 0, status: "active",
          effective_from: new Date(now - 3600_000).toISOString(),
          expires_at: new Date(now + 86400_000).toISOString(),
        },
      ],
      ai_ledger_entry: [],
      ai_allowance_notice: [],
    });

    // 转付费后来源 = subscription:q_paid → 旧 trial 桶不计入可用（服务端会 402）。
    const gated = await loadAiAllowanceSnapshot(conn, { planCyclePrefix: "subscription:quota_subscription:q_paid:" });
    expect(gated.available).toBe(150);
    expect(gated.terminated).toBe(28);
    const trialBucket = gated.buckets.find((b) => b.id === "ai_allowance_bucket:trial")!;
    expect(trialBucket.unusableBySource).toBe(true);
    expect(aiAllowanceBucketStatusLabel(trialBucket)).toBe("已终止");

    // 快照缺失/来源为 none → 全部 plan_cycle 失格；购买桶不受影响。
    const none = await loadAiAllowanceSnapshot(conn, { planCyclePrefix: null });
    expect(none.available).toBe(50);
    expect(none.terminated).toBe(128);

    // 不传 gate（旧行为）→ 不过滤。
    const ungated = await loadAiAllowanceSnapshot(conn);
    expect(ungated.available).toBe(178);
  });

  test("时间格式：非法输入返回空串", () => {
    expect(formatAllowanceTime("not-a-date")).toBe("");
    expect(formatAllowanceTime("2026-09-30T02:00:00.000Z")).not.toBe("");
  });
});
