import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import {
  MAGPIE_LOCAL_FRESHNESS_SECONDS, MAGPIE_REMOTE_EVIDENCE_VERSION, MAGPIE_REMOTE_WINDOW_CONTRACT_VERSION,
  magpieRemoteWindowCreateSchema, type MagpieRemoteWindowCreate,
} from "@surreal-ck/shared";
import { DEFAULT_GATE_LIMITS } from "../../ai/office/employee-gates";
import { TARIFFS } from "./pricing";
import {
  assessWindowCost, buildRemoteWindowRequest, routeMatches, windowAmount, windowTariff,
  WindowDenied, type WindowRow,
} from "./window";

const digest = (c: string) => c.repeat(64);
const code = (fn: () => void): string => {
  try { fn(); } catch (e) { return e instanceof WindowDenied ? e.code : `unexpected:${String(e)}`; }
  return "no-throw";
};

/** 与 7c401606 候选同构的远端证据（null+gap、未复核目录 0/0），时间换成新鲜值。 */
function evidence(overrides: Partial<MagpieRemoteWindowCreate["evidence"]> = {}): MagpieRemoteWindowCreate["evidence"] {
  const capturedAt = new Date(Date.now() - 60_000).toISOString();
  const freshness = new Date(Date.parse(capturedAt) + MAGPIE_LOCAL_FRESHNESS_SECONDS * 1000).toISOString();
  return {
    version: MAGPIE_REMOTE_EVIDENCE_VERSION,
    source: { kind: "configured-remote-magpie", endpoint: "https://data.maplayer.top/ofm/v1", model: "remote-magpie/group/work", executionHost: "remote" },
    observation: { capturedAt, digest: digest("d"), routingConfigurationVerified: false },
    accountRef: "mgpc0cfa2b2cd201c321bc7b42a",
    accountBinding: "mgpc0cfa2b2cd201c321bc7b42a",
    route: {
      present: true, group: "group/work", revision: null, digest: null,
      servedModel: "sn-sensenova-6-8-flash", sampledAt: "2026-10-28T08:08:15.89838551Z", expiresAt: null,
      gaps: [
        { field: "revision", reason: "远端只读目录未提供该路由的 revision；不自行编造" },
        { field: "digest", reason: "远端只读接口未提供路由 digest；本工具不计算替代摘要" },
        { field: "expiresAt", reason: "远端只读接口未提供该路由的到期时刻" },
      ],
    },
    pricing: { priceRevision: "remote-magpie-catalog-285bd6a56db6", rawPrompt: "0", rawCompletion: "0", free: true, freeEvidence: "remote-catalog-zero", reviewed: false },
    expiry: { basis: "local-observation-freshness-policy", localFreshnessExpiresAt: freshness, sourceExpiresAt: [], expiresAt: freshness },
    budget: { currency: "USD", totalNanoUsd: 700_000_000, perAttemptNanoUsd: 35_000_000, maxAttempts: 20 },
    gaps: [
      { field: "route.revision", reason: "远端只读目录未提供该路由的 revision；不自行编造" },
      { field: "route.digest", reason: "远端只读接口未提供路由 digest；本工具不计算替代摘要" },
      { field: "route.expiresAt", reason: "远端只读接口未提供该路由的到期时刻" },
    ],
    configurationDigest: digest("c"),
    ...overrides,
  };
}

const runtime = { providerId: "openai", modelId: "group/work", endpoint: "https://data.maplayer.top/ofm/v1" };
const ctx = { totalUsed: 10, committedAttempts: 0, activityTotalLimit: 1_000_000_000, activityPerAttemptLimit: 100_000_000, runtime };

function input(overrides: Partial<MagpieRemoteWindowCreate> = {}): MagpieRemoteWindowCreate {
  const ev = overrides.evidence ?? evidence();
  return {
    activity: "lca-v2-deploy-qa01",
    approvalDigest: digest("a"),
    approvalTask: "cdc2dd4c-0000-4000-8000-000000000000",
    accountRef: "mgpc0cfa2b2cd201c321bc7b42a",
    evidenceExpiresAt: ev.expiry.expiresAt,
    sourceBudgetAttempts: 1,
    sourceBudgetNanoUsd: 35_000_000,
    perAttemptNanoUsd: 35_000_000,
    maxOutputTokens: 8192,
    evidence: ev,
    capacity: { database: "ws_ddad14a98469", entityTables: 4, fieldsPerTable: 12, recordsPerTable: 12, ttlSeconds: 3600, destructive: false, source: "9e44a95d" },
    idempotencyKey: "idem-remote-0001",
    reason: "unit-test",
    ...overrides,
  };
}

function row(overrides: Partial<WindowRow> = {}): WindowRow {
  const created = input();
  const request = buildRemoteWindowRequest(created, ctx);
  return {
    id: new RecordId("internal_ai_window", "w2"), activity: "lca-v2-deploy-qa01",
    approval_digest: digest("a"), approval_task: "cdc2dd4c", account_ref: "mgpc0cfa2b2cd201c321bc7b42a",
    evidence_expires_at: created.evidenceExpiresAt, attempt_limit: 1, source_budget_nano_usd: 35_000_000,
    per_attempt_nano_usd: 35_000_000, attempts: 0, reserved: 0, spent: 0, status: "active", revision: 1,
    route_revision: request.route.revision, route_digest: request.route.digest,
    requested_model: request.route.requestedModel, served_model: request.route.servedModel,
    endpoint: request.route.endpoint, account_binding: request.route.accountBinding,
    price_revision: request.route.priceRevision, price_basis: request.route.priceBasis,
    free_evidence_hash: null, amortized_nano_usd: null, marginal_nano_usd: null,
    max_output_tokens: request.route.maxOutputTokens, sampled_at: request.route.sampledAt,
    route_expires_at: request.route.expiresAt,
    capacity_database: "ws_ddad14a98469", capacity_tables: 4, capacity_fields: 12, capacity_records: 12,
    capacity_ttl_seconds: 3600, capacity_destructive: false, capacity_source: "9e44a95d",
    idempotency_key: "idem-remote-0001", payload_hash: digest("e"), operator: "ops", reason: "test",
    created_at: new Date(), bound_at: null,
    contract_version: request.contractVersion, evidence_version: request.remote?.evidenceVersion ?? null,
    observation_captured_at: request.remote?.observationCapturedAt ?? null, observation_digest: request.remote?.observationDigest ?? null,
    routing_configuration_verified: request.remote?.routingConfigurationVerified ?? null,
    route_provider: request.route.provider, route_gaps: request.remote?.gaps ?? null,
    expiry_basis: request.remote?.expiryBasis ?? null, local_freshness_expires_at: request.remote?.localFreshnessExpiresAt ?? null,
    source_expires_at: request.remote?.sourceExpiresAt ?? null,
    pricing_reviewed: request.remote?.pricingReviewed ?? null, pricing_evidence_revision: request.remote?.pricingEvidenceRevision ?? null,
    ...overrides,
  };
}

describe("remote window contract v2 schema", () => {
  test("versioned strict schema accepts the real null+gap evidence shape", () => {
    expect(MAGPIE_REMOTE_WINDOW_CONTRACT_VERSION).toBe("magpie-window/v2");
    expect(magpieRemoteWindowCreateSchema.safeParse(input()).success).toBe(true);
  });
  test("rejects fabricated/extra fields and a claimed-verified routing configuration", () => {
    expect(magpieRemoteWindowCreateSchema.safeParse({ ...input(), priceBasis: "free-evidence" }).success).toBe(false);
    expect(magpieRemoteWindowCreateSchema.safeParse({ ...input(), requestedModel: "group/work" }).success).toBe(false);
    expect(magpieRemoteWindowCreateSchema.safeParse({ ...input(), endpoint: "https://data.maplayer.top/ofm/v1" }).success).toBe(false);
    expect(magpieRemoteWindowCreateSchema.safeParse({ ...input(), purchase: true }).success).toBe(false);
    const verified = evidence();
    expect(magpieRemoteWindowCreateSchema.safeParse(input({ evidence: { ...verified, observation: { ...verified.observation, routingConfigurationVerified: true } } })).success).toBe(false);
    expect(magpieRemoteWindowCreateSchema.safeParse(input({ evidence: { ...verified, version: "remote-magpie-evidence/2" } })).success).toBe(false);
    const fabricated = evidence();
    expect(magpieRemoteWindowCreateSchema.safeParse(input({ evidence: { ...fabricated, route: { ...fabricated.route, revision: "r-1" } } })).success).toBe(true);
  });
});

describe("remote window validation", () => {
  test("real null+gap is expressible: frozen request keeps nulls and layers local freshness", () => {
    const created = input();
    const request = buildRemoteWindowRequest(created, ctx);
    expect(request.route.revision).toBeNull();
    expect(request.route.digest).toBeNull();
    expect(request.route.expiresAt).toBeNull();
    expect(request.route.requestedModel).toBe("group/work");
    expect(request.route.endpoint).toBe(runtime.endpoint);
    expect(request.route.provider).toBe(runtime.providerId);
    expect(request.route.maxOutputTokens).toBe(8192);
    // 目录 0/0 未复核 → unknown，绝不派生 free-evidence。
    expect(request.route.priceBasis).toBe("unknown");
    expect(request.route.priceRevision).toBe("unknown");
    expect(request.remote?.gaps.map(g => g.field)).toEqual(["revision", "digest", "expiresAt"]);
    expect(request.remote?.localFreshnessExpiresAt).toBe(created.evidenceExpiresAt);
    expect(request.remote?.pricingReviewed).toBe(false);
    expect(request.remote?.pricingEvidenceRevision).toBe("remote-magpie-catalog-285bd6a56db6");
  });
  test("unconfigured runtime is fail-closed, not guessed from evidence", () => {
    expect(code(() => buildRemoteWindowRequest(input(), { ...ctx, runtime: null }))).toBe("magpie-window-runtime-unavailable");
    expect(code(() => buildRemoteWindowRequest(input(), { ...ctx, runtime: { providerId: "openai", modelId: "", endpoint: runtime.endpoint } }))).toBe("magpie-window-runtime-unavailable");
    expect(code(() => buildRemoteWindowRequest(input(), { ...ctx, runtime: { providerId: "openai", modelId: "group/work", endpoint: "" } }))).toBe("magpie-window-runtime-unavailable");
  });
  test("modified endpoint/model vs the controlled runtime config is rejected", () => {
    expect(code(() => buildRemoteWindowRequest(input(), { ...ctx, runtime: { ...runtime, modelId: "group/other" } }))).toBe("magpie-window-route-mismatch");
    expect(code(() => buildRemoteWindowRequest(input(), { ...ctx, runtime: { ...runtime, endpoint: "https://data.maplayer.top/other/v1" } }))).toBe("magpie-window-endpoint-mismatch");
    expect(code(() => buildRemoteWindowRequest(input(), { ...ctx, runtime: { ...runtime, endpoint: "http://data.maplayer.top/ofm/v1" } }))).toBe("magpie-window-endpoint-mismatch");
    const inconsistent = evidence();
    expect(code(() => buildRemoteWindowRequest(input({ evidence: { ...inconsistent, route: { ...inconsistent.route, group: "group/other" } } }), ctx))).toBe("magpie-window-route-mismatch");
  });
  test("identity mismatch (account swap) is rejected", () => {
    expect(code(() => buildRemoteWindowRequest(input({ accountRef: "mgpc-other-account" }), ctx))).toBe("magpie-window-account-mismatch");
    const swapped = evidence();
    expect(code(() => buildRemoteWindowRequest(input({ evidence: { ...swapped, accountBinding: "mgpc-someone-else" } }), ctx))).toBe("magpie-window-account-mismatch");
  });
  test("null+gap must correspond one-to-one on route and top level", () => {
    const dropGap = evidence();
    expect(code(() => buildRemoteWindowRequest(input({ evidence: { ...dropGap, route: { ...dropGap.route, gaps: dropGap.route.gaps.slice(0, 2) }, gaps: dropGap.gaps } }), ctx))).toBe("magpie-window-gap-inconsistent");
    const dropTop = evidence();
    expect(code(() => buildRemoteWindowRequest(input({ evidence: { ...dropTop, gaps: dropTop.gaps.slice(0, 2) } }), ctx))).toBe("magpie-window-gap-inconsistent");
    const valueWithGap = evidence();
    expect(code(() => buildRemoteWindowRequest(input({ evidence: { ...valueWithGap, route: { ...valueWithGap.route, revision: "r-1" } } }), ctx))).toBe("magpie-window-gap-inconsistent");
    const duplicate = evidence();
    expect(code(() => buildRemoteWindowRequest(input({ evidence: { ...duplicate, route: { ...duplicate.route, gaps: [...duplicate.route.gaps, { field: "revision", reason: "x" }] } } }), ctx))).toBe("magpie-window-gap-inconsistent");
  });
  test("local freshness policy: captured+7200s only, never extended, never future-captured", () => {
    const shifted = evidence();
    const badFreshness = new Date(Date.parse(shifted.observation.capturedAt) + 8_000_000).toISOString();
    expect(code(() => buildRemoteWindowRequest(input({ evidence: { ...shifted, expiry: { ...shifted.expiry, localFreshnessExpiresAt: badFreshness, expiresAt: badFreshness } }, evidenceExpiresAt: badFreshness }), ctx))).toBe("magpie-window-observation-invalid");
    const extended = evidence();
    expect(code(() => buildRemoteWindowRequest(input({ evidenceExpiresAt: new Date(Date.parse(extended.expiry.expiresAt) + 60_000).toISOString() }), ctx))).toBe("magpie-window-observation-invalid");
    const future = evidence();
    expect(code(() => buildRemoteWindowRequest(input({ evidence: { ...future, observation: { ...future.observation, capturedAt: new Date(Date.now() + 60_000).toISOString() } } }), ctx))).toBe("magpie-window-observation-invalid");
  });
  test("remote-provided expiry bounds the window; absent remote expiry stays null", () => {
    const bounded = evidence();
    const earlier = new Date(Date.parse(bounded.expiry.expiresAt) - 3_600_000).toISOString();
    expect(code(() => buildRemoteWindowRequest(input({ evidence: { ...bounded, expiry: { ...bounded.expiry, sourceExpiresAt: [earlier] } } }), ctx))).toBe("magpie-window-observation-invalid");
    // 远端给出路由到期时刻：缺口声明同步移除（null ⟺ gap 一一对应）；早于本地证据期即拒绝。
    const withRoute = evidence();
    const keep = withRoute.route.gaps.filter(g => g.field !== "expiresAt");
    const stripped = { ...withRoute, route: { ...withRoute.route, gaps: keep }, gaps: withRoute.gaps.filter(g => g.field !== "route.expiresAt") };
    const tooEarly = new Date(Date.parse(withRoute.expiry.expiresAt) - 3_600_000).toISOString();
    expect(code(() => buildRemoteWindowRequest(input({ evidence: { ...stripped, route: { ...stripped.route, expiresAt: tooEarly } } }), ctx))).toBe("magpie-window-observation-invalid");
    const routeExpiry = new Date(Date.parse(withRoute.expiry.expiresAt) + 3_600_000).toISOString();
    const request = buildRemoteWindowRequest(input({ evidence: { ...stripped, route: { ...stripped.route, expiresAt: routeExpiry } } }), ctx);
    expect(request.route.expiresAt).toBe(routeExpiry);
    expect(request.remote?.gaps.map(g => g.field)).toEqual(["revision", "digest"]);
  });
  test("approved envelope bounds attempts/USD/output", () => {
    expect(code(() => buildRemoteWindowRequest(input({ sourceBudgetAttempts: 21 }), { ...ctx, totalUsed: 0 }))).toBe("magpie-window-envelope-exceeded");
    expect(code(() => buildRemoteWindowRequest(input({ sourceBudgetNanoUsd: 700_000_001 }), ctx))).toBe("magpie-window-envelope-exceeded");
    expect(code(() => buildRemoteWindowRequest(input({ perAttemptNanoUsd: 35_000_001 }), ctx))).toBe("magpie-window-envelope-exceeded");
    expect(code(() => buildRemoteWindowRequest(input({ maxOutputTokens: 8193 }), ctx))).toBe("magpie-window-request-bound-exceeded");
    expect(code(() => buildRemoteWindowRequest(input({ approvalDigest: `${"a7537d2c".repeat(8)}`.slice(0, 64) }), ctx))).toBe("magpie-window-legacy-rejected");
    expect(code(() => buildRemoteWindowRequest(input(), { ...ctx, totalUsed: 30 }))).toBe("magpie-window-remaining-insufficient");
  });
  test("unreviewed catalog 0/0 never becomes free-evidence; reviewed price requires a matching certificate", () => {
    const reviewed = evidence();
    expect(code(() => buildRemoteWindowRequest(input({ evidence: { ...reviewed, pricing: { ...reviewed.pricing, reviewed: true } } }), ctx))).toBe("magpie-window-price-revision-unavailable");
  });
  test("output bound is cross-checked against the matched certificate; the product ceiling still wins", () => {
    const certified = TARIFFS.find(t => t.revision === "openai-mini-2026-10-09")!;
    const priced = () => {
      const ev = evidence();
      return input({
        evidence: {
          ...ev,
          source: { ...ev.source, endpoint: "https://api.openai.com/v1" },
          route: { ...ev.route, servedModel: certified.model },
          pricing: { ...ev.pricing, reviewed: true },
        },
      });
    };
    const openaiRuntime = { ...ctx, runtime: { ...runtime, endpoint: "https://api.openai.com/v1" } };
    // 证书上限高于产品天花板：提交证书值先撞旧天花板——该证书组合继续拒绝，不扩大天花板。
    expect(certified.maxOutput).toBeGreaterThan(DEFAULT_GATE_LIMITS.maxOutputTokensPerCall);
    expect(code(() => buildRemoteWindowRequest({ ...priced(), maxOutputTokens: certified.maxOutput }, openaiRuntime))).toBe("magpie-window-request-bound-exceeded");
    // 天花板内的不等值：通过天花板后必须与证书 maxOutput 交叉核对 → mismatch（不从入参猜输出上限）。
    expect(code(() => buildRemoteWindowRequest({ ...priced(), maxOutputTokens: DEFAULT_GATE_LIMITS.maxOutputTokensPerCall }, openaiRuntime))).toBe("magpie-window-request-bound-mismatch");
    expect(code(() => buildRemoteWindowRequest({ ...priced(), maxOutputTokens: 1 }, openaiRuntime))).toBe("magpie-window-request-bound-mismatch");
  });
  test("no usable certificate within the product output ceiling exists today (recorded honestly, no fabricated certificates)", () => {
    // 冻结正例要求已核证书 maxOutput ∈ (0, 产品天花板]；当前 TARIFFS 只有 16384 / 0 / 65536，
    // 没有可用证书。按授权不改 TARIFFS、不虚构证书：正 per-token 路径在现网数据下不可达，
    // 如实以本断言记录；将来新增兼容证书时此断言会失败，正是需要补正例的信号。
    const usable = TARIFFS.filter(t => t.maxOutput > 0 && t.maxOutput <= DEFAULT_GATE_LIMITS.maxOutputTokensPerCall);
    expect(usable).toEqual([]);
  });
});

describe("remote window runtime gate", () => {
  test("unknown price stays closed: no tariff, no amount, no assessment", () => {
    const w = row();
    expect(code(() => windowTariff(w))).toBe("magpie-window-price-unassessed");
    expect(code(() => windowAmount(w))).toBe("magpie-window-price-unassessed");
    expect(assessWindowCost(w, { inputTokens: 1, outputTokens: 1, cachedInputTokens: null, reasoningTokens: null }, w.served_model)).toMatchObject({ cost: null, status: "unknown" });
  });
  test("frozen provider/model/endpoint must match the runtime identity exactly", () => {
    const w = row();
    expect(routeMatches(w, "openai", "group/work", "https://data.maplayer.top/ofm/v1")).toBe(true);
    expect(routeMatches(w, "openai", "group/work", "https://data.maplayer.top/ofm/v2")).toBe(false);
    expect(routeMatches(w, "openai", "group/other", "https://data.maplayer.top/ofm/v1")).toBe(false);
    expect(routeMatches(w, "anthropic", "group/work", "https://data.maplayer.top/ofm/v1")).toBe(false);
    expect(routeMatches(row({ route_provider: "remote-magpie" }), "remote-magpie", "group/work", "https://data.maplayer.top/ofm/v1")).toBe(true);
    expect(routeMatches(row({ route_provider: "remote-magpie" }), "openai", "group/work", "https://data.maplayer.top/ofm/v1")).toBe(false);
  });
  test("v1 rows without route_provider keep the legacy openai rule", () => {
    const legacy = row({ route_provider: null });
    expect(routeMatches(legacy, "openai", "group/work", "https://data.maplayer.top/ofm/v1")).toBe(true);
    expect(routeMatches(legacy, "anthropic", "group/work", "https://data.maplayer.top/ofm/v1")).toBe(false);
  });
});
