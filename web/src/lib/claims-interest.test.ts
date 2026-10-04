import { describe, expect, test } from "bun:test";
import { DateTime } from "surrealdb";
import {
  listClaimSubmissions,
  listInterestCalculations,
  parseRateSegmentsJson,
  recalculateSubmission,
} from "./claims-interest";
import type { SurrealConn } from "./surreal";

type Call = { kind: "query"; sql: string } | { kind: "create"; table: string; data: Record<string, unknown> };

function fakeConn(opts: {
  submission?: Record<string, unknown> | null;
  submissions?: Array<Record<string, unknown>>;
  calculations?: Array<Record<string, unknown>>;
}): { conn: SurrealConn; calls: Call[] } {
  const calls: Call[] = [];
  const conn = {
    async query<T>(sql: string): Promise<T[]> {
      calls.push({ kind: "query", sql });
      if (sql.includes("FROM interest_calculation")) {
        return (opts.calculations ?? []) as T[];
      }
      if (sql.includes("FROM $submission")) {
        return (opts.submission ? [opts.submission] : []) as T[];
      }
      if (sql.includes("FROM claim_submission")) {
        return (opts.submissions ?? []) as T[];
      }
      return [] as T[];
    },
    async createRecord<T>(table: string, data: Record<string, unknown>): Promise<T> {
      calls.push({ kind: "create", table, data });
      return { id: "interest_calculation:t1", ...data } as T;
    },
  } as unknown as SurrealConn;
  return { conn, calls };
}

const manualSubmission = {
  id: "claim_submission:s1",
  principal: 100000,
  interest_start: new DateTime("2024-01-01T00:00:00Z"),
  interest_end: new DateTime("2025-01-01T00:00:00Z"),
  interest_method: "simple",
  rate_segments: [
    { start: "2024-01-01", end: "2024-07-01", annual_rate: 0.06 },
    { start: "2024-07-01", end: "2025-01-01", annual_rate: 0.08 },
  ],
  penalty: null,
};

describe("recalculateSubmission", () => {
  test("手算例题快照：分段与合计写库，rule_version 持久化", async () => {
    const { conn, calls } = fakeConn({ submission: manualSubmission });
    const res = await recalculateSubmission(conn, "claim_submission:s1");

    expect(res.ok).toBe(true);
    const create = calls.find((c) => c.kind === "create");
    expect(create).toBeDefined();
    if (create?.kind !== "create") throw new Error("expected create call");
    expect(create.table).toBe("interest_calculation");
    expect(create.data.rule_version).toBe("interest-rules/v1");
    expect(create.data.days_total).toBe(366);
    expect((create.data.segments as Array<Record<string, unknown>>).map((s) => s.interest))
      .toEqual([2991.78, 4032.88]);
    expect(create.data.total_interest).toBe(7024.66);
    expect(create.data.penalty_amount).toBe(0);
    expect(create.data.total_amount).toBe(7024.66);
    expect((create.data.inputs as Record<string, unknown>).interest_start).toBe("2024-01-01");
    expect(create.data.calculated_at).toBeInstanceOf(DateTime);
  });

  test("申报不存在 → submission-not-found，不写库", async () => {
    const { conn, calls } = fakeConn({ submission: null });
    const res = await recalculateSubmission(conn, "claim_submission:missing");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("submission-not-found");
    expect(calls.filter((c) => c.kind === "create")).toHaveLength(0);
  });

  test("无效申报（空分段/缺起息日/截止不晚于起息）→ 明确错误且不写半截金额", async () => {
    for (const [code, patch] of [
      ["empty-rate-segments", { rate_segments: [] }],
      ["missing-interest-start", { interest_start: null }],
      ["interest-end-not-after-start", { interest_end: new DateTime("2023-01-01T00:00:00Z") }],
      ["invalid-rate-segment", { rate_segments: [{ start: "2024-01-01", end: "2025-01-01" }] }],
    ] as const) {
      const { conn, calls } = fakeConn({ submission: { ...manualSubmission, ...patch } });
      const res = await recalculateSubmission(conn, "claim_submission:s1");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe(code);
      expect(calls.filter((c) => c.kind === "create")).toHaveLength(0);
    }
  });

  test("只读申报：不触碰 creditor_roster / enterprise_ledger，不写 claim_submission", async () => {
    const { conn, calls } = fakeConn({ submission: manualSubmission });
    await recalculateSubmission(conn, "claim_submission:s1");
    const sql = calls.filter((c) => c.kind === "query").map((c) => (c as { sql: string }).sql).join("\n");
    expect(sql).not.toContain("creditor_roster");
    expect(sql).not.toContain("enterprise_ledger");
    expect(calls.filter((c) => c.kind === "create").map((c) => (c as { table: string }).table))
      .toEqual(["interest_calculation"]);
  });
});

describe("listClaimSubmissions", () => {
  test("只读列出申报行并规整字段", async () => {
    const submissions = [{
      id: "claim_submission:s1",
      identity_code: "91320100MA01HC001X",
      status: "draft",
      principal: 100000,
      submitted_at: new DateTime("2024-06-01T00:00:00Z"),
    }];
    const { conn } = fakeConn({ submissions });
    const rows = await listClaimSubmissions(conn);
    expect(rows).toEqual([{
      id: "claim_submission:s1",
      identity_code: "91320100MA01HC001X",
      status: "draft",
      principal: 100000,
      submitted_at: "2024-06-01T00:00:00.000Z",
    }]);
  });
});

describe("parseRateSegmentsJson", () => {
  test("留空 → null（走单段简表）", () => {
    expect(parseRateSegmentsJson("")).toEqual({ ok: true, segments: null });
    expect(parseRateSegmentsJson("   ")).toEqual({ ok: true, segments: null });
  });

  test("合法两段数组原样返回", () => {
    const res = parseRateSegmentsJson(
      '[{"start":"2024-01-01","end":"2024-07-01","annual_rate":0.06},{"start":"2024-07-01","end":"2025-01-01","annual_rate":0.08}]',
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.segments).toHaveLength(2);
  });

  test("非法 JSON / 非数组 / 空数组 / 非对象元素 → 错误", () => {
    for (const bad of ["{", "123", "[]", "[1]", '"x"']) {
      const res = parseRateSegmentsJson(bad);
      expect(res.ok).toBe(false);
    }
  });
});

describe("listInterestCalculations", () => {
  test("历史快照按 calculated_at 倒序返回，rule_version/segments 原样读出", async () => {
    const calculations = [{
      id: "interest_calculation:old",
      submission_id: "claim_submission:s1",
      rule_version: "interest-rules/v1",
      inputs: { principal: 100000 },
      segments: [{ index: 0, days: 182, interest: 2991.78 }],
      days_total: 366,
      total_interest: 7024.66,
      penalty_amount: 0,
      total_amount: 7024.66,
      calculated_at: new DateTime("2024-06-01T00:00:00Z"),
    }];
    const { conn } = fakeConn({ calculations });
    const rows = await listInterestCalculations(conn, "claim_submission:s1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rule_version).toBe("interest-rules/v1");
    expect(rows[0]!.segments[0]!.interest).toBe(2991.78);
  });
});
