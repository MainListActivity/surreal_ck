import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { TOKEN_PLAN_PLAN_TYPE_FREE } from "@surreal-ck/shared";
import { MEASUREMENT_CYCLE } from "./store";
import { actualCost, TARIFFS } from "./pricing";
import { aggregateAssessments, assessAttempt, COST_ASSESSMENT_VERSION, type AssessedAttempt, type AssessmentContext, type EvidenceRevision } from "./assessment";
import type { Attempt } from "./store";

const DOC = "ee84aaf9aff935b4f5a4ea7313b50941815abf8cd838df790e056f2f142c44ea";
const SAMPLED = "2026-10-15T17:57:35.106Z";
const EXPIRES = "2026-10-15T20:37:59.000Z";
const REV6: EvidenceRevision = {
  revision: 6, state: "enabled", createdAt: "2026-10-15T18:17:00.000Z",
  documentHash: DOC, evidenceKind: "reviewed-token-plan", accountPlanType: TOKEN_PLAN_PLAN_TYPE_FREE,
  accountRef: "snv67a4f8085b59953cf4ce7af9", sampledAt: SAMPLED, expiresAt: EXPIRES,
  endpoint: "https://token.sensenova.cn/v1", model: "sensenova-6.8-flash-lite", priceRevision: "sensenova-token-plan-2026-10-10",
};
const CTX: AssessmentContext = {
  cycle: {
    id: MEASUREMENT_CYCLE, activity: "lca-v2-deploy-qa01", attempts: 4, attempt_limit: 30,
    enabled_revision: 6, approval_revision: "7c976161-aaaa-4bbb-8ccc-0123456789ab@9",
    evidence_hash: DOC, expires_at: EXPIRES,
  },
  revisions: [
    { ...REV6, revision: 4, state: "disabled", createdAt: "2026-10-15T18:10:00.000Z", documentHash: "00".repeat(32) },
    { ...REV6, revision: 5, state: "disabled", createdAt: "2026-10-15T18:15:00.000Z" },
    REV6,
  ],
};

let seq = 0;
function mkAttempt(overrides: Partial<Attempt> = {}): Attempt {
  seq += 1;
  return {
    id: new RecordId("internal_ai_attempt", `aaaaaaaa-bbbb-4ccc-8ddd-${String(seq).padStart(12, "0")}`),
    measurement_cycle: MEASUREMENT_CYCLE,
    sequence: seq, retry_index: 0, state: "uncertain", reserved: 0, cost: null,
    run_hash: "runhash" + seq, key_hash: "k" + seq, logical_hash: "l" + seq, stage: "respond",
    provider: "openai", model: "sensenova-6.8-flash-lite", actual_model: "sensenova-6.8-flash-lite",
    request_id: "req-" + seq,
    usage: { inputTokens: 349, outputTokens: 62, cachedInputTokens: 0, reasoningTokens: 37 },
    usage_source: "provider", price_revision: "sensenova-token-plan-2026-10-10", currency: "USD",
    started_at: "2026-10-15T18:22:03.492Z", ended_at: "2026-10-15T18:22:08.000Z",
    ...overrides,
  };
}
const assessed = (a: Attempt): AssessedAttempt => ({ id: String(a.id), sequence: a.sequence, runHash: a.run_hash, state: a.state, costAssessment: assessAttempt(a, CTX) });

describe("costAssessment 逐 attempt 规则", () => {
  test("真实脱敏样本（非零 reasoning）得 measured_derived 且成本 0；账本原字段不被触碰", () => {
    const a = mkAttempt();
    const r = assessAttempt(a, CTX);
    expect(r.status).toBe("measured_derived");
    expect(r.costNanoUsd).toBe(0);
    expect(r.currency).toBe("USD");
    expect(r.version).toBe(COST_ASSESSMENT_VERSION);
    expect(r.certificate).toBe("sensenova-token-plan-usage-2026-10-15");
    expect(r.reasons).toEqual([]);
    expect(r.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.evidence).toMatchObject({ revision: 6, documentHash: DOC, expiresAt: EXPIRES });
    // 账本字段保持 uncertain/cost=null，评价不改写原状态。
    expect(a.state).toBe("uncertain");
    expect(a.cost).toBeNull();
    // 历史结算语义不变：actualCost 对同一 usage 仍返回 null。
    expect(actualCost(TARIFFS.find(t => t.revision === a.price_revision)!, a.usage!, a.actual_model)).toBeNull();
  });

  test("reasoning 接近 output 上界的真实样本同样 measured_derived", () => {
    const r = assessAttempt(mkAttempt({ usage: { inputTokens: 3608, outputTokens: 4010, cachedInputTokens: 3072, reasoningTokens: 3848 } }), CTX);
    expect(r).toMatchObject({ status: "measured_derived", costNanoUsd: 0 });
  });

  test("非白名单价目（openai-mini）scope-excluded → unverifiable", () => {
    const r = assessAttempt(mkAttempt({ price_revision: "openai-mini-2026-10-09", model: "gpt-4o-mini-2024-07-18", actual_model: "gpt-4o-mini-2024-07-18" }), CTX);
    expect(r.status).toBe("unverifiable");
    expect(r.reasons).toContain("scope-excluded");
    expect(r.costNanoUsd).toBeNull();
  });

  test("未知价目 revision → unverifiable", () => {
    const r = assessAttempt(mkAttempt({ price_revision: "sensenova-2099-01-01" }), CTX);
    expect(r.status).toBe("unverifiable");
    expect(r.reasons).toContain("price-revision-unknown");
  });

  test("模型不符 / actual_model 缺失或不符 → unverifiable", () => {
    expect(assessAttempt(mkAttempt({ model: "sensenova-u1" }), CTX).reasons).toContain("model-mismatch");
    expect(assessAttempt(mkAttempt({ actual_model: null }), CTX).reasons).toContain("actual-model-missing");
    expect(assessAttempt(mkAttempt({ actual_model: "other-model" }), CTX).reasons).toContain("actual-model-mismatch");
  });

  test("usage 缺失 / 非 provider 来源 → uncertain usage-missing", () => {
    for (const a of [mkAttempt({ usage: null }), mkAttempt({ usage_source: "unknown" }), mkAttempt({ usage_source: "estimated" })]) {
      const r = assessAttempt(a, CTX);
      expect(r.status).toBe("uncertain");
      expect(r.reasons).toContain("usage-missing");
      expect(r.costNanoUsd).toBeNull();
    }
  });

  test("usage 必填缺失 / 非法值 / 未知计费维度", () => {
    expect(assessAttempt(mkAttempt({ usage: { inputTokens: null, outputTokens: 62, cachedInputTokens: 0, reasoningTokens: 0 } }), CTX).reasons).toContain("usage-field-missing");
    expect(assessAttempt(mkAttempt({ usage: { inputTokens: -1, outputTokens: 62, cachedInputTokens: 0, reasoningTokens: 0 } }), CTX).reasons).toContain("usage-field-invalid");
    expect(assessAttempt(mkAttempt({ usage: { inputTokens: 1.5, outputTokens: 62, cachedInputTokens: 0, reasoningTokens: 0 } }), CTX).reasons).toContain("usage-field-invalid");
    expect(assessAttempt(mkAttempt({ usage: { inputTokens: 349, outputTokens: 62, cachedInputTokens: 0, reasoningTokens: 37, audioTokens: 4 } as Attempt["usage"] }), CTX).reasons).toContain("usage-dimension-unknown");
  });

  test("边界关系：cache>input、reasoning>output 均拒绝", () => {
    expect(assessAttempt(mkAttempt({ usage: { inputTokens: 100, outputTokens: 62, cachedInputTokens: 200, reasoningTokens: 0 } }), CTX).reasons).toContain("usage-cache-exceeds-input");
    expect(assessAttempt(mkAttempt({ usage: { inputTokens: 100, outputTokens: 62, cachedInputTokens: 0, reasoningTokens: 63 } }), CTX).reasons).toContain("usage-reasoning-exceeds-output");
  });

  test("零费率下仍无条件执行输出上限（堵住 actualCost 只在正费率查 maxOutput 的旧口）", () => {
    const over = assessAttempt(mkAttempt({ usage: { inputTokens: 349, outputTokens: 65537, cachedInputTokens: 0, reasoningTokens: 0 } }), CTX);
    expect(over.reasons).toContain("usage-output-over-ceiling");
    expect(over.status).toBe("uncertain");
    const overIn = assessAttempt(mkAttempt({ usage: { inputTokens: 262145, outputTokens: 62, cachedInputTokens: 0, reasoningTokens: 0 } }), CTX);
    expect(overIn.reasons).toContain("usage-input-over-ceiling");
    // 反例对照：旧 actualCost 在零费率下不查 output 上限——本评价层必须查。
    expect(actualCost(TARIFFS.find(t => t.revision === "sensenova-token-plan-2026-10-10")!, { inputTokens: 349, outputTokens: 65537, cachedInputTokens: 0, reasoningTokens: 0 }, "sensenova-6.8-flash-lite")).toBe(0);
  });

  test("证据窗口不覆盖调用时刻 → unverifiable", () => {
    expect(assessAttempt(mkAttempt({ started_at: "2026-10-15T17:00:00.000Z" }), CTX).reasons).toContain("evidence-not-covering-call");
    expect(assessAttempt(mkAttempt({ ended_at: "2026-10-15T20:40:00.000Z" }), CTX).reasons).toContain("evidence-not-covering-call");
    expect(assessAttempt(mkAttempt({ started_at: null }), CTX).reasons).toContain("call-time-missing");
  });

  test("非 FREE 账户 / 错误账户 / 错误证据类型 / 错误 endpoint → unverifiable", () => {
    const ctxOf = (rev: Partial<EvidenceRevision>): AssessmentContext => ({ ...CTX, revisions: [{ ...REV6, ...rev }] });
    expect(assessAttempt(mkAttempt(), ctxOf({ accountPlanType: "TOKEN_PLAN_PLAN_TYPE_PAID" })).reasons).toContain("account-plan-not-free");
    expect(assessAttempt(mkAttempt(), ctxOf({ accountRef: "snvother" })).reasons).toContain("account-mismatch");
    expect(assessAttempt(mkAttempt(), ctxOf({ evidenceKind: "reviewed-service" })).reasons).toContain("evidence-kind-mismatch");
    expect(assessAttempt(mkAttempt(), ctxOf({ endpoint: "https://token.sensenova.cn/batch" })).reasons).toContain("endpoint-mismatch");
    expect(assessAttempt(mkAttempt(), ctxOf({ priceRevision: "sensenova-other" })).reasons).toContain("evidence-revision-mismatch");
    expect(assessAttempt(mkAttempt(), ctxOf({ model: "sensenova-6.7" })).reasons).toContain("evidence-revision-mismatch");
  });

  test("周期证据不匹配 / 无周期 / 非周期 attempt 找不到 enabled revision", () => {
    expect(assessAttempt(mkAttempt(), { ...CTX, cycle: { ...CTX.cycle!, evidence_hash: "00".repeat(32) } }).reasons).toContain("measurement-cycle-evidence-mismatch");
    expect(assessAttempt(mkAttempt(), { ...CTX, cycle: null }).reasons).toContain("measurement-cycle-unknown");
    expect(assessAttempt(mkAttempt({ measurement_cycle: "other-cycle" }), CTX).reasons).toContain("measurement-cycle-unknown");
    // 无 measurement_cycle 的旧 attempt：revisions 为空 → evidence-revision-unknown
    expect(assessAttempt(mkAttempt({ measurement_cycle: undefined }), { ...CTX, revisions: [] }).reasons).toContain("evidence-revision-unknown");
    // 调用时刻最新 revision 是 disabled → not-enabled
    const disabledOnly: AssessmentContext = { ...CTX, revisions: [{ ...REV6, state: "disabled" }] };
    expect(assessAttempt(mkAttempt({ measurement_cycle: undefined }), disabledOnly).reasons).toContain("evidence-revision-not-enabled");
    // enabled revision 覆盖时刻 → 可核定（旧 attempt 也能在 FREE 证据下核定）
    expect(assessAttempt(mkAttempt({ measurement_cycle: undefined }), CTX).status).toBe("measured_derived");
  });

  test("同一 attempt 投影可复算：sourceHash 稳定", () => {
    const a = mkAttempt();
    expect(assessAttempt(a, CTX).sourceHash).toBe(assessAttempt(a, CTX).sourceHash);
  });
});

describe("costAssessment 聚合契约", () => {
  test("run 内重试/失败/续跑全部列出；任一未知 ⇒ run 与整体不核定", () => {
    const good1 = assessed(mkAttempt({ run_hash: "runA" }));
    const good2 = assessed(mkAttempt({ run_hash: "runA" }));
    const bad = assessed(mkAttempt({ run_hash: "runA", usage: null }));
    const agg = aggregateAssessments([good1, good2, bad]);
    expect(agg.attemptCount).toBe(3);
    expect(agg.runCount).toBe(1);
    expect(agg.unknownCallCount).toBe(1);
    expect(agg.unknownRunCount).toBe(1);
    expect(agg.status).toBe("unassessed");
    expect(agg.totalCostNanoUsd).toBeNull();
    expect(agg.knownSubtotalNanoUsd).toBe(0);
    expect(agg.reasonCounts["usage-missing"]).toBe(1);
    const run = agg.runs[0];
    expect(run.attemptIds).toHaveLength(3);
    expect(run.status).toBe("unassessed");
    expect(run.totalCostNanoUsd).toBeNull();
    expect(run.reasons).toContain("usage-missing");
  });

  test("全部 measured ⇒ 总成本核定；唯一 attempt ID 去重不扩分母", () => {
    const a = assessed(mkAttempt({ run_hash: "runA" }));
    const b = assessed(mkAttempt({ run_hash: "runB" }));
    const agg = aggregateAssessments([a, b, a]);
    expect(agg.attemptCount).toBe(2);
    expect(agg.runCount).toBe(2);
    expect(agg.status).toBe("assessed");
    expect(agg.totalCostNanoUsd).toBe(0);
  });

  test("零成功路径 perSuccessfulTask=null+undefined_zero_success；提供成功数才做除法", () => {
    const list = [assessed(mkAttempt({ run_hash: "runA" }))];
    expect(aggregateAssessments(list, { successfulTasks: 0 }).perSuccessfulTask)
      .toEqual({ costNanoUsd: null, successfulTasks: 0, reason: "undefined_zero_success" });
    expect(aggregateAssessments(list, { successfulTasks: 4 }).perSuccessfulTask)
      .toEqual({ costNanoUsd: 0, successfulTasks: 4, reason: null });
    expect(aggregateAssessments(list).perSuccessfulTask.reason).toBe("successful-tasks-not-provided");
    const unassessed = [assessed(mkAttempt({ run_hash: "runA", usage: null }))];
    expect(aggregateAssessments(unassessed, { successfulTasks: 0 }).perSuccessfulTask.reason).toBe("cost-unassessed");
  });
});
