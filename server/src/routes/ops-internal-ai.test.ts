import { z } from "zod";
import { InternalAiRegistration } from "../internal-ai/registration";
import { HttpError } from "../http-error";
import { expect, test, spyOn } from "bun:test";
import { Hono } from "hono";
import { handleError } from "../middleware/error";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { createOpsInternalAiRoutes } from "./ops-internal-ai";
import { InternalAiStore } from "../internal-ai/store";
import { InternalAiGate } from "../internal-ai/gate";
const neverDb = new InternalAiGate(new InternalAiStore(async () => { throw new Error("must not reach store"); }));
const allow: MiddlewareHandler<AppBindings> = async (_c, next) => next();
test("customer without ops auth cannot read runtime or ledger", async () => {
  const app = new Hono<AppBindings>().route("/", createOpsInternalAiRoutes({ gate: neverDb, runtime: {} })).onError(handleError);
  expect((await app.request("/api/ops/internal-ai/runtime")).status).toBe(401);
  expect((await app.request("/api/ops/internal-ai/activities/test")).status).toBe(401);
});
test("runtime reports unavailable balance, strips URL credentials, and never exposes key/query", async () => {
  const app = new Hono<AppBindings>().route("/", createOpsInternalAiRoutes({ gate: neverDb, requireOperator: allow, runtime: { provider: "openai", model: "gpt-4o-mini", endpoint: "https://user:secret@example.com/v1?key=secret" } }));
  const response = await app.request("/api/ops/internal-ai/runtime");
  const body = z.object({ endpointHost: z.string().nullable(), balance: z.object({ status: z.string() }), defaultEnabled: z.boolean(), mastraVersion: z.string() }).passthrough().parse(await response.json());
  expect(body.endpointHost).toBeNull(); expect(body.balance.status).toBe("unavailable"); expect(body.defaultEnabled).toBe(false);
  expect(body.mastraVersion).toBe("1.36.0"); expect(JSON.stringify(body)).not.toContain("secret");
  expect((await app.request("/api/ops/internal-ai/activities/test", { method: "POST" })).status).toBe(404);
});

test("registration endpoints retain ops authentication", async () => {
  const app = new Hono<AppBindings>().route("/", createOpsInternalAiRoutes({ gate: neverDb, runtime: {} })).onError(handleError);
  for (const path of ["company-proof", "activities/test/evidence", "activities/test/enable", "activities/test/disable", "identities/revoke"]) {
    expect((await app.request(`/api/ops/internal-ai/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
  }
});
test("company broker proof-only envelope reaches verification; unknown fields cannot pass", async () => {
  const app = new Hono<AppBindings>().route("/", createOpsInternalAiRoutes({ gate: neverDb, runtime: {}, requireOperator: allow })).onError(handleError);
  const send = (body: unknown) => app.request("/api/ops/internal-ai/company-proof", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await send({ proof: "synthetic-invalid-jwt" })).status).toBe(422);
  expect((await send({ proof: "synthetic-invalid-jwt", subject: "forged" })).status).toBe(400);
});
test("supplier probe exposes unsupported current SenseNova without accepting URL/proxy input", async () => {
  const app = new Hono<AppBindings>().route("/", createOpsInternalAiRoutes({ gate: neverDb, runtime: { endpoint: "https://token.sensenova.cn/v1" }, requireOperator: allow })).onError(handleError);
  const response = await app.request("/api/ops/internal-ai/supplier-probe?host=token.sensenova.cn");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ host: "token.sensenova.cn", status: "unsupported", capabilities: [] });
  expect((await app.request("/api/ops/internal-ai/supplier-probe?host=other.example")).status).toBe(403);
  for (const host of ["token.sensenova.cn/path", "user:secret@token.sensenova.cn", "token.sensenova.cn?key=secret"]) {
    expect((await app.request(`/api/ops/internal-ai/supplier-probe?host=${encodeURIComponent(host)}`)).status).toBe(400);
  }
});


test("costAssessment 只读投影：默认不出现，?assessment=1 追加逐条与聚合，账本字段不变", async () => {
  const { RecordId } = await import("surrealdb");
  const { MEASUREMENT_CYCLE } = await import("../internal-ai/store");
  const attempt = {
    id: new RecordId("internal_ai_attempt", "11111111-2222-4333-8444-555555555555"),
    measurement_cycle: MEASUREMENT_CYCLE, sequence: 1, retry_index: 0, state: "uncertain", reserved: 0, cost: null,
    run_hash: "runhashA", key_hash: "k", logical_hash: "l", stage: "respond", provider: "openai",
    model: "sensenova-6.8-flash-lite", actual_model: "sensenova-6.8-flash-lite", request_id: "req-1",
    usage: { inputTokens: 349, outputTokens: 62, cachedInputTokens: 0, reasoningTokens: 37 },
    usage_source: "provider", price_revision: "sensenova-token-plan-2026-10-10", currency: "USD",
    started_at: "2026-10-15T18:22:03.492Z", ended_at: "2026-10-15T18:22:08.000Z",
  };
  const doc = "ee84aaf9aff935b4f5a4ea7313b50941815abf8cd838df790e056f2f142c44ea";
  const store = neverDb.store;
  const mocks = [
    spyOn(store, "activity").mockImplementation(async () => ({ goal: "g", enabled: true, total_limit: 0, per_attempt_limit: 0, attempt_limit: 30, reserved: 0, spent: 0, attempts: 4, approval_revision: "a@9", evidence_expires_at: "2026-10-15T20:37:59.000Z", price_revisions: ["sensenova-token-plan-2026-10-10"], balance_nano_usd: null, balance_currency: null, balance_source: "token-plan:" + doc, balance_sampled_at: "2026-10-15T17:57:35.106Z", balance_evidence_hash: doc, auto_topup_disabled: true, service_approved: true, evidence_kind: "reviewed-token-plan", plan_name: "Free", plan_source_url: "https://www.sensenova.cn/token-plan", quota_unit: "points", quota_amount: 60000, quota_window_seconds: 18000, quota_remaining: 59918, no_payment_instrument: null, account_plan_type: "TOKEN_PLAN_PLAN_TYPE_FREE" })),
    spyOn(store, "page").mockImplementation(async () => [attempt]),
    spyOn(store, "target").mockImplementation(async () => ({ reserved: 0, spent: 0, attempts: 0 })),
    spyOn(store, "measurementCycle").mockImplementation(async () => ({ activity: "lca-v2-deploy-qa01", attempts: 4, attempt_limit: 30, enabled_revision: 6, approval_revision: "a@9", evidence_hash: doc, expires_at: "2026-10-15T20:37:59.000Z" })),
    spyOn(store, "revisionEvidence").mockImplementation(async () => [{ revision: 6, state: "enabled", created_at: "2026-10-15T18:17:00.000Z", document_hash: doc, evidence_kind: "reviewed-token-plan", account_plan_type: "TOKEN_PLAN_PLAN_TYPE_FREE", account_ref: "snv67a4f8085b59953cf4ce7af9", balance_sampled_at: "2026-10-15T17:57:35.106Z", evidence_expires_at: "2026-10-15T20:37:59.000Z", endpoint: "https://token.sensenova.cn/v1", model: "sensenova-6.8-flash-lite", price_revision: "sensenova-token-plan-2026-10-10" }]),
  ];
  try {
    const app = new Hono<AppBindings>().route("/", createOpsInternalAiRoutes({ gate: neverDb, runtime: {}, requireOperator: allow })).onError(handleError);
    // 默认响应：无 costAssessment 字段
    const plain = await app.request("/api/ops/internal-ai/activities/lca-v2-deploy-qa01");
    const plainBody = await plain.json() as { attempts: { costAssessment?: unknown }[]; costAssessment?: unknown };
    expect(plain.status).toBe(200);
    expect(plainBody.costAssessment).toBeUndefined();
    expect(plainBody.attempts[0].costAssessment).toBeUndefined();
    // ?assessment=1：逐条投影 + 聚合
    const res = await app.request("/api/ops/internal-ai/activities/lca-v2-deploy-qa01?assessment=1&successfulTasks=0");
    expect(res.status).toBe(200);
    const body = await res.json() as { attempts: { state: string; cost: unknown; costAssessment: { status: string; costNanoUsd: number | null; sourceHash: string } }[]; costAssessment: { status: string; totalCostNanoUsd: number | null; unknownCallCount: number; perSuccessfulTask: { reason: string | null } } };
    const item = body.attempts[0];
    // 原账本字段原样保留
    expect(item.state).toBe("uncertain");
    expect(item.cost).toBeNull();
    expect(item.costAssessment.status).toBe("measured_derived");
    expect(item.costAssessment.costNanoUsd).toBe(0);
    expect(item.costAssessment.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.costAssessment.status).toBe("assessed");
    expect(body.costAssessment.totalCostNanoUsd).toBe(0);
    expect(body.costAssessment.unknownCallCount).toBe(0);
    expect(body.costAssessment.perSuccessfulTask.reason).toBe("undefined_zero_success");
    // 非法参数拒绝
    expect((await app.request("/api/ops/internal-ai/activities/lca-v2-deploy-qa01?assessment=bogus")).status).toBe(400);
    expect((await app.request("/api/ops/internal-ai/activities/lca-v2-deploy-qa01?assessment=1&successfulTasks=-1")).status).toBe(400);
  } finally { mocks.forEach(m => m.mockRestore()); }
});

test("costAssessment 授权不变：无 ops 凭证带 assessment=1 仍 401", async () => {
  const app = new Hono<AppBindings>().route("/", createOpsInternalAiRoutes({ gate: neverDb, runtime: {} })).onError(handleError);
  expect((await app.request("/api/ops/internal-ai/activities/test?assessment=1")).status).toBe(401);
});

test("evidence, enable, disable and revoke forward a strict reason and authenticated operator", async () => {
  const registration = new InternalAiRegistration(async () => { throw new Error("must not touch DB"); });
  const reached = async (input: { operator: string; reason: string }): Promise<never> => {
    expect(input.operator).toBe("synthetic-operator");
    expect(input.reason).toBe("受审操作");
    throw new HttpError(418, "synthetic-reached", "reached service");
  };
  const mocks = [spyOn(registration, "submitEvidence").mockImplementation(reached), spyOn(registration, "enable").mockImplementation(reached),
    spyOn(registration, "disable").mockImplementation(reached), spyOn(registration, "revokeIdentity").mockImplementation(reached)];
  const operator: MiddlewareHandler<AppBindings> = async (c, next) => {
    c.set("platformOperator", { subject: "synthetic-operator", capabilities: ["subscription.manage"] });
    await next();
  };
  const app = new Hono<AppBindings>().route("/", createOpsInternalAiRoutes({ gate: neverDb, registration, runtime: {}, requireOperator: operator })).onError(handleError);
  try {
    for (const [path, body] of [
      ["activities/test/evidence", { revision: 1, document: "{}", reason: "受审操作" }],
      ["activities/test/enable", { revision: 1, reason: "受审操作", measurementCycle: true }],
      ["activities/test/disable", { reason: "受审操作" }],
      ["identities/revoke", { activity: "test", alias: "LCA04_MEMBER", reason: "受审操作" }],
    ] as const) {
      const request = (payload: unknown) => app.request(`/api/ops/internal-ai/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      expect((await request(body)).status).toBe(418);
      expect((await request({ ...body, budget: 1000000000 })).status).toBe(400);
    }
  } finally { mocks.forEach(mock => mock.mockRestore()); }
});
