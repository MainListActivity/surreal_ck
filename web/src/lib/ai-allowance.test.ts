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
  test("LCA14 旧试用无终止标记也不可消费；未来加量不误计，补偿保持独立", async () => {
    const now = Date.now();
    const from = new Date(now - 60_000).toISOString(), until = new Date(now + 86400_000).toISOString();
    const base = { total: 28, available: 28, reserved: 0, settled: 0, status: "active", effective_from: from, expires_at: until };
    const conn = fakeConn({ ai_rate_card: [], ai_ledger_entry: [], ai_allowance_notice: [], ai_allowance_bucket: [
      { ...base, id: "ai_allowance_bucket:legacy", kind: "plan_cycle", period_key: "trial:quota_subscription:provision:cycle" },
      { ...base, id: "ai_allowance_bucket:future", kind: "purchased", period_key: "independent", effective_from: new Date(now + 60_000).toISOString() },
      { ...base, id: "ai_allowance_bucket:compensation", kind: "compensation", period_key: "independent" },
    ] });
    const snapshot = await loadAiAllowanceSnapshot(conn, { kind: "subscription", sourceId: "quota_subscription:new", effectiveFrom: from, effectiveUntil: until });
    expect(snapshot.available).toBe(28); // 仅补偿。
    expect(snapshot.terminated).toBe(28);
    expect(snapshot.pending).toBe(28);
    expect(snapshot.buckets[0]?.terminated).toBe(false); // 不伪造旧样本已补标记。
    expect(aiAllowanceBucketStatusLabel(snapshot.buckets[0]!)).toBe("来源已失效，不可消费");
    expect(snapshot.buckets[0]?.consumptionReason).toBe("source_mismatch");
  });
  test("聚合可用 / 预留 / 暂停 / 已过期余额并带出消费记录", async () => {
    const now = Date.now();
    const conn = fakeConn({
      ai_rate_card: [
        { id: "ai_rate_card:research_test_v1", amount: 5, revision: 1, revision_label: "test-rate-v1", tier_label: "快速 AI 回答（测试费率）" },
      ],
      ai_allowance_bucket: [
        {
          id: "ai_allowance_bucket:active", kind: "plan_cycle", label: "月度套餐",
          period_key: "subscription:sub:2026-09", total: 100, available: 60, reserved: 10, settled: 30,
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

    const snapshot = await loadAiAllowanceSnapshot(conn, { kind: "subscription", sourceId: "sub", effectiveFrom: new Date(Date.now() - 86400_000).toISOString(), effectiveUntil: new Date(Date.now() + 86400_000).toISOString() });
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
    const snapshot = await loadAiAllowanceSnapshot(conn, { kind: "subscription", sourceId: "sub", effectiveFrom: new Date(Date.now() - 86400_000).toISOString(), effectiveUntil: new Date(Date.now() + 86400_000).toISOString() });
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
    const snapshot = await loadAiAllowanceSnapshot(conn, { kind: "subscription", sourceId: "sub", effectiveFrom: new Date(Date.now() - 86400_000).toISOString(), effectiveUntil: new Date(Date.now() + 86400_000).toISOString() });
    expect(snapshot.available).toBe(200);
    expect(snapshot.terminated).toBe(30);
    expect(snapshot.expired).toBe(0);
  });

  test("时间格式：非法输入返回空串", () => {
    expect(formatAllowanceTime("not-a-date")).toBe("");
    expect(formatAllowanceTime("2026-09-30T02:00:00.000Z")).not.toBe("");
  });
});
