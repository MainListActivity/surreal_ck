import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { MAGPIE_WINDOW_CONTRACT_VERSION, magpieWindowCreateSchema, type MagpieWindowCreate } from "@surreal-ck/shared";
import { TARIFFS, worstCost } from "./pricing";
import {
  assessWindowCost, canonicalJson, legacyHit, payloadHash, routeMatches, usageValid,
  validateCapacity, validateRoute, validateWindowCreate, windowAmount, windowTariff,
  WindowDenied, type WindowRow,
} from "./window";

const digest = (c: string) => c.repeat(64);
const future = () => new Date(Date.now() + 3_600_000).toISOString();
const past = () => new Date(Date.now() - 3_600_000).toISOString();

function input(overrides: Partial<MagpieWindowCreate> = {}): MagpieWindowCreate {
  return {
    activity: "lca-v2-deploy-qa01",
    approvalDigest: digest("a"),
    approvalTask: "cdc2dd4c-0000-4000-8000-000000000000",
    accountRef: "snv67a4f8085b59953cf4ce7af9",
    evidenceExpiresAt: future(),
    sourceBudgetAttempts: 5,
    sourceBudgetNanoUsd: 100_000_000,
    perAttemptNanoUsd: 10_000_000,
    route: {
      revision: "magpie-route-1", digest: digest("b"), requestedModel: "group/work",
      servedModel: "sn-sensenova-6-8-flash", endpoint: "http://127.0.0.1:3425/v1",
      accountBinding: "snv67a4f8085b59953cf4ce7af9", priceRevision: "magpie-free-1",
      priceBasis: "free-evidence", freeEvidenceHash: digest("c"), maxOutputTokens: 8192,
      sampledAt: future(), expiresAt: future(),
    },
    capacity: {
      database: "ws_ddad14a98469", entityTables: 4, fieldsPerTable: 12,
      recordsPerTable: 12, ttlSeconds: 3600, destructive: false, source: "9e44a95d",
    },
    idempotencyKey: "idem-00000001",
    reason: "unit-test",
    ...overrides,
  };
}
const ctx = { totalUsed: 10, committedAttempts: 0, activityTotalLimit: 1_000_000_000, activityPerAttemptLimit: 100_000_000 };

function row(overrides: Partial<WindowRow> = {}): WindowRow {
  return {
    id: new RecordId("internal_ai_window", "w1"), activity: "lca-v2-deploy-qa01",
    approval_digest: digest("a"), approval_task: "cdc2dd4c", account_ref: "snv67a4f8085b59953cf4ce7af9",
    evidence_expires_at: future(), attempt_limit: 5, source_budget_nano_usd: 100_000_000,
    per_attempt_nano_usd: 10_000_000, attempts: 0, reserved: 0, spent: 0, status: "active", revision: 1,
    route_revision: "magpie-route-1", route_digest: digest("b"), requested_model: "group/work",
    served_model: "sn-sensenova-6-8-flash", endpoint: "http://127.0.0.1:3425/v1",
    account_binding: "snv67a4f8085b59953cf4ce7af9", price_revision: "magpie-free-1",
    price_basis: "free-evidence", free_evidence_hash: digest("c"), amortized_nano_usd: null,
    marginal_nano_usd: null, max_output_tokens: 8192, sampled_at: future(), route_expires_at: future(),
    capacity_database: "ws_ddad14a98469", capacity_tables: 4, capacity_fields: 12, capacity_records: 12,
    capacity_ttl_seconds: 3600, capacity_destructive: false, capacity_source: "9e44a95d",
    idempotency_key: "idem-00000001", payload_hash: digest("d"), operator: "ops", reason: "test",
    created_at: new Date(), bound_at: null,
    ...overrides,
  };
}
const code = (fn: () => void): string => {
  try { fn(); } catch (e) { return e instanceof WindowDenied ? e.code : `unexpected:${String(e)}`; }
  return "no-throw";
};

describe("magpie-window contract", () => {
  test("versioned schema is strict and rejects purchase/recharge fields", () => {
    expect(MAGPIE_WINDOW_CONTRACT_VERSION).toBe("magpie-window/v1");
    expect(magpieWindowCreateSchema.safeParse(input()).success).toBe(true);
    expect(magpieWindowCreateSchema.safeParse({ ...input(), purchase: true }).success).toBe(false);
    expect(magpieWindowCreateSchema.safeParse({ ...input(), activity: "../etc" }).success).toBe(false);
  });
  test("canonical json/hash is order stable", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(payloadHash({ a: 1 })).toBe(payloadHash({ a: 1 }));
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }));
  });
  test("legacy cycle/approval/proof prefixes are rejected", () => {
    expect(legacyHit("a7537d2c-3b76-42b3-bfb8-459956340984")).toBe("a7537d2c");
    expect(legacyHit("f3974e8f-dead-beef-0000-000000000000")).toBe("f3974e8f");
    expect(legacyHit("4FFF2947-a7a8-40e8-ad14-f2b1a97c9861@9".toLowerCase())).toBe("4fff2947");
    expect(legacyHit("cdc2dd4c-0000-4000-8000-000000000000")).toBeNull();
    expect(code(() => validateWindowCreate(input({ approvalTask: "a7537d2c-3b76-42b3-bfb8-459956340984" }), ctx))).toBe("magpie-window-legacy-rejected");
  });
});

describe("capacity scope", () => {
  test("accepts the approved 9e44a95d bounds and rejects anything wider", () => {
    expect(code(() => validateCapacity(input().capacity))).toBe("no-throw");
    const wider: MagpieWindowCreate["capacity"][] = [
      { ...input().capacity, database: "ws_other" },
      { ...input().capacity, entityTables: 6 },
      { ...input().capacity, entityTables: 2 },
      { ...input().capacity, fieldsPerTable: 24 },
      { ...input().capacity, recordsPerTable: 25 },
      { ...input().capacity, ttlSeconds: 86_401 },
      { ...input().capacity, destructive: true },
      { ...input().capacity, source: " " },
      { ...input().capacity, source: "other-approval" },
    ];
    for (const capacity of wider) {
      expect(code(() => validateCapacity(capacity))).toBe("magpie-window-capacity-out-of-scope");
    }
  });
});

describe("route and budget", () => {
  test("wrong account binding / expired route / contradictory disclosure are rejected", () => {
    expect(code(() => validateRoute(input({ accountRef: "other-account" })))).toBe("magpie-window-account-mismatch");
    expect(code(() => validateRoute(input({ route: { ...input().route, expiresAt: past() } })))).toBe("magpie-window-route-expired");
    expect(code(() => validateRoute(input({ route: { ...input().route, freeEvidenceHash: undefined } })))).toBe("magpie-window-price-basis-invalid");
    expect(code(() => validateRoute(input({ route: { ...input().route, amortizedNanoUsd: 1 } })))).toBe("magpie-window-price-basis-invalid");
    expect(code(() => validateRoute(input({ route: { ...input().route, priceBasis: "per-token", priceRevision: "unknown" } })))).toBe("magpie-window-price-revision-unavailable");
    expect(code(() => validateRoute(input({ route: { ...input().route, priceBasis: "per-token", priceRevision: "openai-mini-2026-10-09", servedModel: "gpt-4o-mini-2024-07-18" } })))).toBe("magpie-window-price-revision-unavailable");
    expect(code(() => validateRoute(input({ route: { ...input().route, priceBasis: "subscription-amortized" } })))).toBe("magpie-window-price-basis-invalid");
  });
  test("per-token route must match a real certificate host/model", () => {
    const route = { ...input().route, priceBasis: "per-token" as const, priceRevision: "openai-mini-2026-10-09", servedModel: "gpt-4o-mini-2024-07-18", endpoint: "https://api.openai.com/v1" };
    expect(code(() => validateRoute(input({ route })))).toBe("no-throw");
  });
  test("remaining attempts deduct all historical use and never re-grant 30", () => {
    expect(code(() => validateWindowCreate(input(), { ...ctx, totalUsed: 30 }))).toBe("magpie-window-remaining-insufficient");
    expect(code(() => validateWindowCreate(input({ sourceBudgetAttempts: 2 }), { ...ctx, totalUsed: 29 }))).toBe("magpie-window-remaining-insufficient");
    expect(code(() => validateWindowCreate(input({ sourceBudgetAttempts: 1 }), { ...ctx, totalUsed: 29 }))).toBe("no-throw");
    expect(code(() => validateWindowCreate(input({ sourceBudgetAttempts: 1 }), { ...ctx, totalUsed: 28, committedAttempts: 2 }))).toBe("magpie-window-remaining-insufficient");
  });
  test("inherits USD caps and rejects expired evidence", () => {
    expect(code(() => validateWindowCreate(input({ sourceBudgetNanoUsd: 1_000_000_001 }), ctx))).toBe("magpie-window-cap-inheritance");
    expect(code(() => validateWindowCreate(input({ perAttemptNanoUsd: 100_000_001 }), ctx))).toBe("magpie-window-cap-inheritance");
    expect(code(() => validateWindowCreate(input({ evidenceExpiresAt: past() }), ctx))).toBe("magpie-window-evidence-expired");
  });
});

describe("runtime route and per-request cost", () => {
  test("route snapshot must match scheme/host/port/path/requested model", () => {
    const w = row();
    expect(routeMatches(w, "openai", "group/work", "http://127.0.0.1:3425/v1")).toBe(true);
    expect(routeMatches(w, "openai", "group/work", "http://127.0.0.1:3426/v1")).toBe(false);
    expect(routeMatches(w, "openai", "group/work", "http://127.0.0.1:3425/v2")).toBe(false);
    expect(routeMatches(w, "openai", "group/other", "http://127.0.0.1:3425/v1")).toBe(false);
    expect(routeMatches(w, "anthropic", "group/work", "http://127.0.0.1:3425/v1")).toBe(false);
  });
  test("amounts: free=0, per-token=worst cost, amortized=per-attempt, unknown blocked", () => {
    expect(windowAmount(row())).toBe(0);
    const openai = TARIFFS.find(t => t.revision === "openai-mini-2026-10-09")!;
    expect(windowAmount(row({ price_basis: "per-token", price_revision: openai.revision, served_model: openai.model, endpoint: "https://api.openai.com/v1" }))).toBe(worstCost(openai));
    expect(windowAmount(row({ price_basis: "subscription-amortized", per_attempt_nano_usd: 42 }))).toBe(42);
    expect(code(() => windowAmount(row({ price_basis: "unknown" })))).toBe("magpie-window-price-unassessed");
    expect(windowTariff(row()).maxOutput).toBe(8192);
  });
  test("usage validity rejects cache>input and reasoning>output", () => {
    expect(usageValid({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 10, reasoningTokens: 5 })).toBe(true);
    expect(usageValid({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 11, reasoningTokens: null })).toBe(false);
    expect(usageValid({ inputTokens: 10, outputTokens: 5, cachedInputTokens: null, reasoningTokens: 6 })).toBe(false);
    expect(usageValid({ inputTokens: null, outputTokens: 5, cachedInputTokens: null, reasoningTokens: null })).toBe(false);
  });
  test("servedModel drift and missing/invalid usage never become zero", () => {
    const w = row();
    expect(assessWindowCost(w, { inputTokens: 10, outputTokens: 5, cachedInputTokens: null, reasoningTokens: null }, "other-model")).toMatchObject({ cost: null, status: "route-drift", routeDrift: true });
    expect(assessWindowCost(w, null, w.served_model)).toMatchObject({ cost: null, status: "usage-missing" });
    expect(assessWindowCost(w, { inputTokens: 10, outputTokens: 5, cachedInputTokens: 20, reasoningTokens: null }, w.served_model)).toMatchObject({ cost: null, status: "invalid-usage" });
    expect(assessWindowCost(w, { inputTokens: 10, outputTokens: 5, cachedInputTokens: null, reasoningTokens: null }, w.served_model)).toMatchObject({ cost: 0, status: "free-evidence" });
  });
  test("per-token and amortized bases are assessed separately from null", () => {
    const openai = TARIFFS.find(t => t.revision === "openai-mini-2026-10-09")!;
    const perToken = row({ price_basis: "per-token", price_revision: openai.revision, served_model: openai.model, endpoint: "https://api.openai.com/v1" });
    const assessed = assessWindowCost(perToken, { inputTokens: 1_000, outputTokens: 500, cachedInputTokens: 0, reasoningTokens: null }, openai.model);
    expect(assessed.cost).toBe(1_000 * openai.input + 500 * openai.output);
    expect(assessed.status).toBe("assessed");
    const amortized = row({ price_basis: "subscription-amortized", amortized_nano_usd: 500, marginal_nano_usd: 0 });
    expect(assessWindowCost(amortized, { inputTokens: 1, outputTokens: 1, cachedInputTokens: null, reasoningTokens: null }, amortized.served_model)).toMatchObject({ cost: null, status: "unassessed", amortized: 500, marginal: 0 });
    expect(assessWindowCost(row({ price_basis: "unknown" }), { inputTokens: 1, outputTokens: 1, cachedInputTokens: null, reasoningTokens: null }, row().served_model)).toMatchObject({ cost: null, status: "unknown" });
  });
});
