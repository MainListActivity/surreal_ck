import { describe, expect, test } from "bun:test";
import {
  calculateInterest,
  INTEREST_RULES_VERSION_V1,
  type ClaimsInterestSuccess,
} from "./claims-interest";

function ok(result: ReturnType<typeof calculateInterest>): ClaimsInterestSuccess {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result;
}

describe("calculateInterest (interest-rules/v1)", () => {
  test("文档手算例题：两段分段单利逐段舍入后合计 7024.66", () => {
    const result = ok(calculateInterest({
      principal: 100000,
      interest_start: "2024-01-01",
      interest_end: "2025-01-01",
      interest_method: "simple",
      rate_segments: [
        { start: "2024-01-01", end: "2024-07-01", annual_rate: 0.06 },
        { start: "2024-07-01", end: "2025-01-01", annual_rate: 0.08 },
      ],
      penalty: null,
    }));

    expect(result.rule_version).toBe(INTEREST_RULES_VERSION_V1);
    expect(result.interest_method).toBe("simple");
    expect(result.days_total).toBe(366); // 2024 闰年，2-29 计入
    expect(result.segments).toHaveLength(2);

    const [s1, s2] = result.segments;
    expect(s1).toMatchObject({
      start: "2024-01-01", end: "2024-07-01", days: 182,
      base: 100000, annual_rate: 0.06, interest: 2991.78,
    });
    expect(s2).toMatchObject({
      start: "2024-07-01", end: "2025-01-01", days: 184,
      base: 100000, annual_rate: 0.08, interest: 4032.88,
    });
    expect(result.total_interest).toBe(7024.66);
    expect(result.penalty_amount).toBe(0);
    expect(result.total_amount).toBe(7024.66);
  });

  test("半开区间 [起,止)：单日区间计 1 天", () => {
    const result = ok(calculateInterest({
      principal: 36500,
      interest_start: "2024-01-01",
      interest_end: "2024-01-02",
      rate_segments: [{ start: "2024-01-01", end: "2024-01-02", annual_rate: 0.1 }],
    }));
    expect(result.segments[0].days).toBe(1);
    expect(result.segments[0].interest).toBe(10); // 36500×0.1×1/365
    expect(result.total_interest).toBe(10);
  });

  test("跨闰日：2024-02-28→2024-03-01 计 2 天（2-29 计入），平年同期计 1 天", () => {
    const leap = ok(calculateInterest({
      principal: 100000,
      interest_start: "2024-02-28",
      interest_end: "2024-03-01",
      rate_segments: [{ start: "2024-02-28", end: "2024-03-01", annual_rate: 0.1 }],
    }));
    expect(leap.days_total).toBe(2);
    expect(leap.total_interest).toBe(54.79); // 100000×0.1×2/365=54.7945…

    const plain = ok(calculateInterest({
      principal: 100000,
      interest_start: "2023-02-28",
      interest_end: "2023-03-01",
      rate_segments: [{ start: "2023-02-28", end: "2023-03-01", annual_rate: 0.1 }],
    }));
    expect(plain.days_total).toBe(1);
    expect(plain.total_interest).toBe(27.4); // 100000×0.1×1/365=27.3972…
  });

  test("分段先各自舍入到分再求和（非先求和再舍入）", () => {
    // 每段原始 73×0.02×1/365 = 0.004 → 各段舍入为 0.00，合计 0.00；
    // 若先求和再舍入会得到 0.01，本用例锁定逐段舍入语义。
    const result = ok(calculateInterest({
      principal: 73,
      interest_start: "2024-01-01",
      interest_end: "2024-01-03",
      rate_segments: [
        { start: "2024-01-01", end: "2024-01-02", annual_rate: 0.02 },
        { start: "2024-01-02", end: "2024-01-03", annual_rate: 0.02 },
      ],
    }));
    expect(result.segments.map((s) => s.interest)).toEqual([0, 0]);
    expect(result.total_interest).toBe(0);
  });

  test("显式 annual_rate=0 覆盖全区间 → 不计息合计 0", () => {
    const result = ok(calculateInterest({
      principal: 50000,
      interest_start: "2024-01-01",
      interest_end: "2024-06-01",
      rate_segments: [{ start: "2024-01-01", end: "2024-06-01", annual_rate: 0 }],
    }));
    expect(result.total_interest).toBe(0);
    expect(result.total_amount).toBe(0);
  });

  test("无约定违约金 → penalty_amount 为 0", () => {
    for (const penalty of [null, undefined, 0]) {
      const result = ok(calculateInterest({
        principal: 1000,
        interest_start: "2024-01-01",
        interest_end: "2024-02-01",
        rate_segments: [{ start: "2024-01-01", end: "2024-02-01", annual_rate: 0.05 }],
        penalty,
      }));
      expect(result.penalty).toBeNull();
      expect(result.penalty_amount).toBe(0);
      expect(result.total_amount).toBe(result.total_interest);
    }
  });

  test("固定金额违约金计入 total_amount", () => {
    const result = ok(calculateInterest({
      principal: 1000,
      interest_start: "2024-01-01",
      interest_end: "2024-02-01",
      rate_segments: [{ start: "2024-01-01", end: "2024-02-01", annual_rate: 0 }],
      penalty: { kind: "fixed_amount", amount: 500 },
    }));
    expect(result.penalty_amount).toBe(500);
    expect(result.total_amount).toBe(500);
    // 申报字段形式（裸 number）等价 fixed_amount
    const bare = ok(calculateInterest({
      principal: 1000,
      interest_start: "2024-01-01",
      interest_end: "2024-02-01",
      rate_segments: [{ start: "2024-01-01", end: "2024-02-01", annual_rate: 0 }],
      penalty: 500,
    }));
    expect(bare.penalty_amount).toBe(500);
  });

  test("日利率违约金按同一计息窗口单利计（本金×日利率×天数），无复利", () => {
    const result = ok(calculateInterest({
      principal: 100000,
      interest_start: "2024-01-01",
      interest_end: "2025-01-01",
      rate_segments: [
        { start: "2024-01-01", end: "2024-07-01", annual_rate: 0.06 },
        { start: "2024-07-01", end: "2025-01-01", annual_rate: 0.08 },
      ],
      penalty: { kind: "daily_rate", daily_rate: 0.0001 }, // 万分之一/日
    }));
    expect(result.penalty_amount).toBe(3660); // 100000×0.0001×366
    expect(result.total_amount).toBe(7024.66 + 3660);
  });

  test("确定性：同一输入两次计算结果深度相等", () => {
    const input = {
      principal: 88888.88,
      interest_start: "2024-02-01",
      interest_end: "2024-09-15",
      rate_segments: [
        { start: "2024-02-01", end: "2024-05-01", annual_rate: 0.055 },
        { start: "2024-05-01", end: "2024-09-15", annual_rate: 0.0725 },
      ],
      penalty: { kind: "daily_rate", daily_rate: 0.0002 },
    } as const;
    expect(calculateInterest(input)).toEqual(calculateInterest(input));
  });

  describe("失败路径：明确错误且不产出任何金额", () => {
    const base = {
      principal: 1000,
      interest_start: "2024-01-01",
      interest_end: "2024-02-01",
      rate_segments: [{ start: "2024-01-01", end: "2024-02-01", annual_rate: 0.05 }],
    };

    test.each([
      ["missing-interest-start", { ...base, interest_start: undefined }],
      ["missing-interest-start", { ...base, interest_start: "" }],
      ["missing-interest-end", { ...base, interest_end: null }],
      ["invalid-interest-start", { ...base, interest_start: "2024-13-01" }],
      ["invalid-interest-start", { ...base, interest_start: "2024-02-30" }],
      ["invalid-interest-end", { ...base, interest_end: "not-a-date" }],
      ["interest-end-not-after-start", { ...base, interest_end: "2024-01-01" }],
      ["interest-end-not-after-start", { ...base, interest_end: "2023-12-31" }],
      ["invalid-principal", { ...base, principal: undefined }],
      ["invalid-principal", { ...base, principal: -1 }],
      ["invalid-principal", { ...base, principal: Number.NaN }],
      ["empty-rate-segments", { ...base, rate_segments: [] }],
      ["empty-rate-segments", { ...base, rate_segments: undefined }],
      ["empty-rate-segments", { ...base, rate_segments: "not-array" }],
      ["invalid-rate-segment", {
        ...base,
        rate_segments: [{ start: "2024-01-01", end: "2024-02-01", annual_rate: -0.01 }],
      }],
      ["invalid-rate-segment", {
        ...base,
        rate_segments: [{ start: "2024-01-01", end: "2024-02-01" }],
      }],
      ["invalid-rate-segment", {
        ...base,
        rate_segments: [{ start: "2024-01-01", end: "2024-01-01", annual_rate: 0.05 }],
      }],
      ["rate-segments-not-contiguous", {
        ...base,
        rate_segments: [
          { start: "2024-01-01", end: "2024-01-15", annual_rate: 0.05 },
          { start: "2024-01-20", end: "2024-02-01", annual_rate: 0.05 },
        ],
      }],
      ["rate-segments-window-mismatch", {
        ...base,
        rate_segments: [{ start: "2024-01-02", end: "2024-02-01", annual_rate: 0.05 }],
      }],
      ["rate-segments-window-mismatch", {
        ...base,
        rate_segments: [{ start: "2024-01-01", end: "2024-01-31", annual_rate: 0.05 }],
      }],
      ["unsupported-interest-method", { ...base, interest_method: "compound" }],
      ["invalid-penalty", { ...base, penalty: -5 }],
      ["invalid-penalty", { ...base, penalty: { kind: "daily_rate", daily_rate: -0.1 } }],
      ["invalid-penalty", { ...base, penalty: { kind: "compound_daily", rate: 0.1 } }],
    ])("%s", (code, input) => {
      const result = calculateInterest(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(code);
        expect(result.error.message.length).toBeGreaterThan(0);
        expect("total_interest" in result).toBe(false);
        expect("segments" in result).toBe(false);
      }
    });
  });
});
