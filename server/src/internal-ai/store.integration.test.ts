import { ModelRouterLanguageModel } from "@mastra/core/llm";
import { InternalBudgetModel } from "./model";
import { createOpenAiCompatibleEmbeddingProvider } from "../resources/embedding-provider";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { RecordId, Surreal, Table } from "surrealdb";
import { InternalAiStore, GOAL, MEASUREMENT_CYCLE, MEASUREMENT_DATABASE, hash, type Attempt } from "./store";
import { InternalAiGate } from "./gate";
import { TARIFFS, worstCost } from "./pricing";
import { inInternalScope } from "./context";
import { meteredDecision } from "./decision";
import { assessAttempt, type AssessmentContext } from "./assessment";
import { TOKEN_PLAN_PLAN_TYPE_FREE } from "@surreal-ck/shared";
const enabled = process.env.RUN_INTERNAL_AI_FORK_TESTS === "1";
const localTest = test.skipIf(!enabled);
// 公司fork，绝不回退PATH中的上游CLI。
const binary = join(homedir(), ".surrealdb/surreal");
let directory = "";
let endpoint = "";
let child: ReturnType<typeof Bun.spawn>;
let db: Surreal;
let db2: Surreal;
let store: InternalAiStore;
let gate: InternalAiGate;
async function start() {
  child = Bun.spawn([binary, "start", "--no-banner", "--log", "none", "--bind", endpoint.replace("ws://", ""), "--user", "root", "--pass", "root", `rocksdb:${join(directory, "data")}`], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 80; i++) { const probe = Bun.spawn([binary, "is-ready", "--endpoint", endpoint], { stdout: "ignore", stderr: "ignore" }); if (await probe.exited === 0) break; if (i === 79) throw new Error("fork not ready"); await Bun.sleep(50); }
  db = new Surreal(); await db.connect(`${endpoint}/rpc`, { authentication: { username: "root", password: "root" } });
  await db.query("DEFINE NAMESPACE IF NOT EXISTS budget_test;"); await db.use({ namespace: "budget_test" });
  await db.query("DEFINE DATABASE IF NOT EXISTS _system;"); await db.use({ namespace: "budget_test", database: "_system" });
  db2 = new Surreal(); await db2.connect(`${endpoint}/rpc`, { authentication: { username: "root", password: "root" }, namespace: "budget_test", database: "_system" });
  store = new InternalAiStore(async () => db); gate = new InternalAiGate(store);
}
async function stop() { try { await db2.close(); await db.close(); } finally { child.kill(); await child.exited; } }
async function activity(id: string, limits: { total?: number; per?: number; count?: number } = {}, registration?: { jti: string; proofExpiresAt: number }) {
  await db.insert(new Table("internal_ai_activity"), { id: new RecordId("internal_ai_activity", id), goal: GOAL, enabled: true, total_limit: limits.total ?? 1000000000, per_attempt_limit: limits.per ?? 100000000, attempt_limit: limits.count ?? 30, approval_revision: "synthetic-test-only", evidence_expires_at: "2099-01-01T00:00:00Z", price_revisions: TARIFFS.map(t => t.revision), balance_nano_usd: 1000000000, balance_currency: "USD", balance_source: `reviewed-document:${"a".repeat(64)}`, balance_sampled_at: "2026-10-09T00:00:00Z", balance_evidence_hash: "a".repeat(64), auto_topup_disabled: true, service_approved: true, ...(registration ? { registration_jti: registration.jti, proof_expires_at: registration.proofExpiresAt } : {}) });
  return { activity: id, runHash: hash(id, "run"), keyHash: hash(id, "key"), logicalHash: hash(id, "key") };
}
/** 配额型活动：官方 Token Plan 证据，无 USD 余额字段；与 enable 写入形状一致。 */
async function tokenPlanActivity(id: string) {
  const tariff = TARIFFS.find(t => t.model === "sensenova-6.8-flash-lite")!;
  await db.insert(new Table("internal_ai_activity"), { id: new RecordId("internal_ai_activity", id), goal: GOAL, enabled: true, total_limit: 1000000000, per_attempt_limit: 100000000, attempt_limit: 30, approval_revision: "synthetic-test-only", evidence_expires_at: "2099-01-01T00:00:00Z", price_revisions: [tariff.revision], evidence_kind: "reviewed-token-plan", plan_name: "SenseNova Token Plan 公测", plan_source_url: "https://www.sensenova.cn/token-plan", account_plan_type: "TOKEN_PLAN_PLAN_TYPE_FREE", quota_unit: "points", quota_amount: 60000, quota_window_seconds: 18000, quota_remaining: 60000, balance_source: `token-plan:${"b".repeat(64)}`, balance_sampled_at: "2026-10-09T00:00:00Z", balance_evidence_hash: "b".repeat(64), auto_topup_disabled: true, service_approved: true });
  return { activity: id, runHash: hash(id, "run"), keyHash: hash(id, "key"), logicalHash: hash(id, "key") };
}
beforeAll(async () => {
  if (!enabled) return;
  directory = await mkdtemp(join(tmpdir(), "internal-ai-fork-"));
  const port = await new Promise<number>((resolve, reject) => { const listener = createServer(); listener.on("error", reject); listener.listen(0, "127.0.0.1", () => { const addr = listener.address(); if (!addr || typeof addr === "string") { reject(new Error("port")); return; } listener.close(() => resolve(addr.port)); }); });
  endpoint = `ws://127.0.0.1:${port}`;
  await start();
  await db.query(await readFile(new URL("../../../shared/sql/system/034-internal-ai-budget.surql", import.meta.url), "utf8"));
  // 035 带来 registration_jti/proof_expires_at：解耦用例要在「已登记活动」的真实形状上验证 proof 窗口。
  await db.query(await readFile(new URL("../../../shared/sql/system/035-internal-ai-registration.surql", import.meta.url), "utf8"));
  await db.query(await readFile(new URL("../../../shared/sql/system/036-internal-ai-token-plan.surql", import.meta.url), "utf8"));
  await db.query(await readFile(new URL("../../../shared/sql/system/037-internal-ai-measurement-cycle.surql", import.meta.url), "utf8"));
  await db.query(await readFile(new URL("../../../shared/sql/system/038-internal-ai-account-plan-type.surql", import.meta.url), "utf8"));
  await db.query(await readFile(new URL("../../../shared/sql/system/039-internal-ai-window.surql", import.meta.url), "utf8"));
  await db.query(await readFile(new URL("../../../shared/sql/system/042-internal-ai-sampling-envelope.surql", import.meta.url), "utf8"));
  await db.query(await readFile(new URL("../../../shared/sql/system/043-internal-ai-window-remote.surql", import.meta.url), "utf8"));
}, 20000);
afterAll(async () => { if (!enabled) return; await stop(); await rm(directory, { recursive: true, force: true }); });
localTest("multi-connection concurrent reservations serialize shared cash; uncertain failures retain money", async () => {
  const tariff = TARIFFS[0]!;
  const scope = await activity("concurrent", { total: 2 * worstCost(tariff) });
  const other = new InternalAiStore(async () => db2);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => (i % 2 ? store : other).reserve({ ...scope, runHash: hash(String(i)), keyHash: hash("key", String(i)) }, "proposal", tariff, worstCost(tariff))));
  const successes = results.filter(r => r.status === "fulfilled");
  expect(successes.length).toBe(2);
  expect((await store.activity("concurrent"))?.attempts).toBe(2);
  expect((await store.activity("concurrent"))?.reserved).toBe(2 * worstCost(tariff));
  const ticket = successes[0]!;
  if (ticket.status !== "fulfilled") throw new Error("test missing ticket");
  await store.sent(ticket.value.id);
  await store.finish(ticket.value.id, { usage: null, actualModel: null, requestId: null, cost: null, failed: true });
  expect((await store.activity("concurrent"))?.reserved).toBe(2 * worstCost(tariff));
  expect((await store.page("concurrent"))[0]?.usage_source).toBe("unknown");
}, 20000);
localTest("independent client processes share the atomic cash reservation", async () => {
  const tariff = TARIFFS[0]!;
  const scope = await activity("processes", { total: 2 * worstCost(tariff) });
  const worker = `
    import { Surreal } from "surrealdb";
    import { InternalAiStore, hash } from ${JSON.stringify(new URL("./store.ts", import.meta.url).pathname)};
    import { TARIFFS, worstCost } from ${JSON.stringify(new URL("./pricing.ts", import.meta.url).pathname)};
    const db = new Surreal();
    try {
      await db.connect(${JSON.stringify(`${endpoint}/rpc`)}, { authentication: { username: "root", password: "root" }, namespace: "budget_test", database: "_system" });
      const store = new InternalAiStore(async () => db);
      const scope = ${JSON.stringify(scope)};
      const tariff = TARIFFS[0];
      const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => store.reserve({ ...scope, runHash: hash(String(process.pid), String(i)) }, "proposal", tariff, worstCost(tariff))));
      console.log(JSON.stringify({ pid: process.pid, accepted: results.filter(r => r.status === "fulfilled").length }));
    } finally { await db.close(); }
  `;
  const clients = Array.from({ length: 2 }, () => Bun.spawn([process.execPath, "--eval", worker], { stdout: "pipe", stderr: "pipe" }));
  const results = await Promise.all(clients.map(async client => {
    const [output, errors, code] = await Promise.all([new Response(client.stdout).text(), new Response(client.stderr).text(), client.exited]);
    if (code !== 0) throw new Error(`reservation fixture process failed: ${errors}`);
    return JSON.parse(output) as { pid: number; accepted: number };
  }));
  expect(results[0]?.pid).not.toBe(results[1]?.pid);
  expect(results.reduce((sum, result) => sum + result.accepted, 0)).toBe(2);
  expect((await store.activity("processes"))?.attempts).toBe(2);
  expect((await store.activity("processes"))?.reserved).toBe(2 * worstCost(tariff));
}, 20000);
localTest("settlement idempotency, spend and model usage persist through actual server restart", async () => {
  const t = TARIFFS[0]!;
  const scope = await activity("restart");
  const row = await store.reserve(scope, "llm-classify", t, worstCost(t)); await store.sent(row.id);
  const finish = { usage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: null, reasoningTokens: null }, actualModel: t.model, requestId: "fixture-only", cost: 13500, failed: false };
  await store.finish(row.id, finish); await store.finish(row.id, finish);
  expect((await store.activity("restart"))?.spent).toBe(13500);
  const uncertain = await store.reserve(scope, "proposal", t, worstCost(t)); await store.sent(uncertain.id);
  await stop(); await start();
  expect((await store.activity("restart"))?.spent).toBe(13500);
  expect((await store.activity("restart"))?.reserved).toBe(worstCost(t));
  expect((await store.page("restart"))[0]?.usage?.inputTokens).toBe(10);
  await expect(store.sent(uncertain.id)).rejects.toThrow("replayed");
}, 20000);
localTest("disabled, missing evidence, per-call cash and attempt thresholds deny before synthetic transport", async () => {
  let sends = 0;
  for (const id of ["disabled", "balance", "price", "per", "count"]) {
    const scope = await activity(id, { per: id === "per" ? 1 : undefined, count: 1 });
    if (id === "disabled") await db.query("UPDATE ONLY $id SET enabled = false", { id: new RecordId("internal_ai_activity", id) });
    if (id === "balance") await db.query("UPDATE ONLY $id SET balance_nano_usd = NONE", { id: new RecordId("internal_ai_activity", id) });
    if (id === "price") await db.query("UPDATE ONLY $id SET price_revisions = []", { id: new RecordId("internal_ai_activity", id) });
    if (id === "count") await store.reserve(scope, "first", TARIFFS[1]!, worstCost(TARIFFS[1]!));
    const caller = meteredDecision(async () => { sends++; throw new Error("transport should not run"); }, gate, "jev-1.13.0");
    await expect(inInternalScope(scope, () => caller({ state: {}, questions: {} }))).rejects.toThrow();
  }
  expect(sends).toBe(0);
});
localTest("Jev fallback retains failed attempt, valid returned usage settles exactly once", async () => {
  const scope = await activity("decision"); let calls = 0;
  const caller = meteredDecision(async () => { calls++; return { model: "jev-1.13.0", answers: {}, usage: { inputTokens: 100, outputTokens: 20 } }; }, gate, "jev-1.13.0");
  await inInternalScope(scope, () => caller({ state: {}, questions: {} }));
  expect(calls).toBe(1); expect((await store.activity("decision"))?.spent).toBe(4200);
  const failing = meteredDecision(async () => { calls++; throw new Error("synthetic timeout"); }, gate, "jev-1.13.0");
  await expect(inInternalScope(scope, () => failing({ state: {}, questions: {} }))).rejects.toThrow();
  expect(calls).toBe(2); expect((await store.activity("decision"))?.reserved).toBe(worstCost(TARIFFS[1]!));
});
localTest("server identity binding ignores run/key resets and resume uses persistent activity", async () => {
  await activity("identity");
  await db.insert(new Table("internal_ai_binding"), { identity_hash: hash("subject", "ws_one"), activity: "identity" });
  const a = await gate.bind("subject", "ws_one", "run1", "key");
  const b = await gate.bind("subject", "ws_one", "run2", "another-key");
  expect(a?.activity).toBe(b?.activity);
  expect(await gate.bind("customer", "ws_one", "run1", "key")).toBeUndefined();
  expect(await gate.bind("subject", "ws_one", "run1")).toEqual(a);
});

localTest("revoked identity denies old and new run/key across restart; deleted binding denied by identity history; customer passthrough intact", async () => {
  let sends = 0;
  const mock = spyOn(ModelRouterLanguageModel.prototype, "doStream").mockImplementation(async () => { sends++; return { stream: new ReadableStream({ start(c) { c.close(); } }) }; });
  try {
    const model = new InternalBudgetModel({ provider: "openai", model: "gpt-4o-mini-2024-07-18", baseUrl: "https://api.openai.com/v1", apiKey: "synthetic-only", internalAiGate: gate }, "revocation-probe", gate);
    const PROBE = { prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "synthetic-only" }] }] };
    const chatAttempt = async (subject: string, ws: string, run: string, key?: string) => {
      const scope = await gate.bind(subject, ws, run, key);
      return gate.inRun(scope, async () => { await model.doStream(PROBE); return scope ? "metered" : "passthrough"; });
    };
    // 标记撤销：binding 持久 revoked 状态，撤销前已计量一次。
    await activity("revocation");
    await db.insert(new Table("internal_ai_binding"), { identity_hash: hash("revoked-subject", "ws_rev"), activity: "revocation" });
    expect(await chatAttempt("revoked-subject", "ws_rev", "first-run", "first-key")).toBe("metered");
    expect(sends).toBe(1);
    await store.revoke("revoked-subject", "ws_rev");
    for (const [run, key] of [["first-run", "first-key"], ["first-run", "swapped-key"], ["escape-run", "escape-key"], ["escape-run", undefined]] as const) {
      await expect(chatAttempt("revoked-subject", "ws_rev", run, key)).rejects.toThrow("binding-revoked");
    }
    expect(sends).toBe(1);
    await stop(); await start();
    await expect(chatAttempt("revoked-subject", "ws_rev", "post-restart-run", "post-restart-key")).rejects.toThrow("binding-revoked");
    expect(sends).toBe(1);
    expect((await store.activity("revocation"))?.attempts).toBe(1);
    // 删除式撤权：binding 被删后凭身份历史核验拒绝，换 run/key 不绕过。
    await activity("revoked-delete");
    await db.insert(new Table("internal_ai_binding"), { identity_hash: hash("deleted-subject", "ws_del"), activity: "revoked-delete" });
    expect(await chatAttempt("deleted-subject", "ws_del", "metered-run", "metered-key")).toBe("metered");
    expect(sends).toBe(2);
    await db.query("DELETE internal_ai_binding WHERE identity_hash = $identity", { identity: hash("deleted-subject", "ws_del") });
    await expect(chatAttempt("deleted-subject", "ws_del", "metered-run")).rejects.toThrow("binding-revoked");
    await expect(chatAttempt("deleted-subject", "ws_del", "escape-run", "escape-key")).rejects.toThrow("binding-revoked");
    expect(sends).toBe(2);
    expect((await store.activity("revoked-delete"))?.attempts).toBe(1);
    // 从未参与内部活动的客户维持原行为：passthrough 传输，无内部账本。
    await activity("bystander");
    expect(await chatAttempt("fresh-customer", "ws_fresh", "customer-run", "customer-key")).toBe("passthrough");
    expect(sends).toBe(3);
    expect((await store.activity("bystander"))?.attempts).toBe(0);
  } finally { mock.mockRestore(); }
}, 20000);

localTest("user gate anchors on reviewed ledger: expired operator proof window neither blocks attempts nor revives denied ones", async () => {
  const t = TARIFFS[0]!;
  const begin = () => gate.begin("proposal", t.provider, t.model, "https://api.openai.com/v1");
  // 登记过的活动（registration_jti 存在），投递证明窗口已远超 300s（proof_expires_at 拨到过去，不真等）。
  await activity("window-live", {}, { jti: "jti-window", proofExpiresAt: 1 });
  await db.insert(new Table("internal_ai_binding"), { identity_hash: hash("window-subject", "ws_window"), activity: "window-live" });
  const bound = await gate.bind("window-subject", "ws_window", "run-live", "key-live");
  expect(bound?.activity).toBe("window-live");
  // >300s 后无人工重刷仍可预留：proof TTL 不再是用户门禁条件。
  const ticket = await gate.inRun(bound, () => begin());
  expect(ticket?.tariff.revision).toBe(t.revision);
  // 证据窗口到期：活动仍 enabled 也立即拒绝（evidence_expires_at 在同一事务强制）。
  await db.query("UPDATE ONLY $id SET evidence_expires_at = '2026-01-01T00:00:00Z'", { id: new RecordId("internal_ai_activity", "window-live") });
  await expect(gate.inRun(bound, () => begin())).rejects.toThrow();
  // disable：立即拒绝。
  await db.query("UPDATE ONLY $id SET evidence_expires_at = '2099-01-01T00:00:00Z', enabled = false", { id: new RecordId("internal_ai_activity", "window-live") });
  await expect(gate.inRun(bound, () => begin())).rejects.toThrow();
  // 撤销：持久标记，同活动内换 run/key 仍拒绝。
  await activity("window-revoked", {}, { jti: "jti-window-revoked", proofExpiresAt: 1 });
  await db.insert(new Table("internal_ai_binding"), { identity_hash: hash("revoked-window-subject", "ws_window"), activity: "window-revoked" });
  const revokedScope = await gate.bind("revoked-window-subject", "ws_window", "run-revoked", "key-revoked");
  await store.revoke("revoked-window-subject", "ws_window");
  await expect(gate.inRun(revokedScope, () => begin())).rejects.toThrow();
  expect((await store.activity("window-revoked"))?.attempts ?? 0).toBe(0);
});

localTest("each provider model step reserves before transport, captures finish usage only, rejects unmetered embedding", async () => {
  const scope = await activity("model-steps");
  let sends = 0;
  const t = TARIFFS[0]!;
  const model = new InternalBudgetModel({ provider: "openai", model: t.model, baseUrl: "https://api.openai.com/v1", apiKey: "synthetic-not-a-real-key" }, "proposal", gate);
  const transport = spyOn(ModelRouterLanguageModel.prototype, "doStream").mockImplementation(async options => {
    const a = await store.activity("model-steps");
    expect(a?.attempts).toBe(sends + 1); expect(a!.reserved).toBeGreaterThanOrEqual(worstCost(t));
    expect(options.maxOutputTokens).toBe(t.maxOutput);
    sends++;
    return { stream: new ReadableStream({ start(c) {
      c.enqueue({ type: "response-metadata", id: "synthetic-request", modelId: t.model });
      c.enqueue({ type: "text-start", id: "text" });
      c.enqueue({ type: "text-delta", id: "text", delta: "fixture body must never enter ledger" });
      c.enqueue({ type: "text-end", id: "text" });
      c.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 20 } }); c.close();
    } }) };
  });
  try {
    for (let step = 0; step < 2; step++) {
      const result = await inInternalScope(scope, () => model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "synthetic prompt must never enter ledger" }] }], maxOutputTokens: 100000 }));
      const reader = result.stream.getReader(); while (!(await reader.read()).done) { /* consume stream */ }
    }
    const ledger = await store.page("model-steps");
    expect(sends).toBe(2); expect(ledger).toHaveLength(2);
    expect(ledger[0]?.usage).toEqual({ inputTokens: 100, outputTokens: 10, cachedInputTokens: 20, reasoningTokens: null });
    expect((await store.activity("model-steps"))?.spent).toBe(39000);
    expect(JSON.stringify(ledger)).not.toContain("fixture body"); expect(JSON.stringify(ledger)).not.toContain("synthetic prompt");
    let embeds = 0;
    const embeddings = createOpenAiCompatibleEmbeddingProvider({ apiKey: "fixture", fetchImpl: async () => { embeds++; throw new Error("should not send"); } });
    await expect(inInternalScope(scope, () => embeddings.embed({ text: "fixture", profile: { provider: "openai", model: "fixture", dimensions: 1, version: "1" } }))).rejects.toThrow("path-unavailable");
    expect(embeds).toBe(0);
  } finally { transport.mockRestore(); }
});

localTest("token-plan activities reserve zero cash, settle zero cost and deny on quota or source mismatch", async () => {
  const tariff = TARIFFS.find(t => t.model === "sensenova-6.8-flash-lite")!;
  expect(worstCost(tariff)).toBe(0);
  const scope = await tokenPlanActivity("token-plan");
  const attempt = await store.reserve(scope, "proposal", tariff, worstCost(tariff));
  expect(attempt.reserved).toBe(0);
  await store.sent(attempt.id);
  await store.finish(attempt.id, { usage: { inputTokens: 2000, outputTokens: 500, cachedInputTokens: null, reasoningTokens: null }, actualModel: tariff.model, requestId: "synthetic-only", cost: 0, failed: false });
  expect((await store.activity("token-plan"))?.spent).toBe(0);
  expect((await store.activity("token-plan"))?.attempts).toBe(1);
  expect((await store.page("token-plan"))[0]?.state).toBe("settled");
  // 配额型证据缺失、计划类型缺失（v1 旧行无 account_plan_type）、出处前缀错误、夹带 USD 余额、
  // 价目版本不符、非零金额预留：全部 fail-closed。非 FREE 值被 schema ASSERT 挡在写入外。
  for (const [id, mutate] of [
    ["tp-exhausted", "quota_remaining = 0"],
    ["tp-missing-plan", "plan_name = NONE"],
    ["tp-v1-legacy", "account_plan_type = NONE, no_payment_instrument = true"],
    ["tp-wrong-source", `balance_source = "reviewed-document:" + balance_evidence_hash`],
    ["tp-usd-mixed", `balance_nano_usd = 1000, balance_currency = "USD"`],
    ["tp-wrong-price", "price_revisions = []"],
    ["tp-disabled", "enabled = false"],
  ] as const) {
    const s = await tokenPlanActivity(id);
    await db.query(`UPDATE ONLY $id SET ${mutate}`, { id: new RecordId("internal_ai_activity", id) });
    await expect(store.reserve(s, "proposal", tariff, worstCost(tariff))).rejects.toThrow();
  }
  // 配额活动上任何非零现金预留同样拒绝（证书/证据不一致）。
  const clean = await tokenPlanActivity("tp-nonzero");
  await expect(store.reserve(clean, "proposal", tariff, 1)).rejects.toThrow();
});

// 测量周期轮换/拒绝诊断用例：独立库隔离（measurement_cycle 单例行不可跨用例复用）。
async function isolatedDb(name: string) {
  const schema = (await Promise.all(["034-internal-ai-budget.surql", "035-internal-ai-registration.surql", "036-internal-ai-token-plan.surql", "037-internal-ai-measurement-cycle.surql", "038-internal-ai-account-plan-type.surql", "039-internal-ai-window.surql", "042-internal-ai-sampling-envelope.surql", "043-internal-ai-window-remote.surql"].map(async f => readFile(new URL(`../../../shared/sql/system/${f}`, import.meta.url), "utf8")))).join("\n");
  await db.query(`DEFINE DATABASE IF NOT EXISTS ${name};`);
  await db.use({ namespace: "budget_test", database: name });
  await db.query(schema);
}
/** 与生产受审活动同形（token-plan 证据 + 已登记 + 测量周期绑定该活动）。 */
async function auditedFixture(activityId: string, subject: string) {
  await tokenPlanActivity(activityId);
  await db.query('UPDATE ONLY $id SET registration_jti = "synthetic-jti", proof_expires_at = 9999999999', { id: new RecordId("internal_ai_activity", activityId) });
  await db.insert(new Table("internal_ai_binding"), { identity_hash: hash(subject, MEASUREMENT_DATABASE), activity: activityId, revoked: false, alias: "LCA04_REMOVABLE", space_id: "synthetic-space", database: MEASUREMENT_DATABASE, workspace_role: "admin", billing_role: "owner", billing_account_ref: "synthetic-billing", revision: 12 });
  const bound = await gate.bind(subject, MEASUREMENT_DATABASE, `run-${activityId}`, `key-${activityId}`);
  if (!bound) throw new Error("missing bound fixture");
  await db.query(`CREATE ONLY $cycle CONTENT { activity: $name, attempts: 0, attempt_limit: 30, enabled_revision: 12, approval_revision: "synthetic-test-only", evidence_hash: $docHash, expires_at: "2099-01-01T00:00:00Z", created_at: time::now() }`, { cycle: new RecordId("internal_ai_measurement_cycle", MEASUREMENT_CYCLE), name: activityId, docHash: "b".repeat(64) });
  return bound;
}

localTest("rotated measurement cycle continues ledger sequence after prior cycle consumed attempts", async () => {
  // 生产故障同形回归钉：旧周期占满 sequence 1..30 且 activity.attempts=0，
  // 轮换新周期 attempts=0 时按 cycle.attempts 派生会撞 internal_ai_sequence 唯一索引。
  const tariff = TARIFFS.find(t => t.model === "sensenova-6.8-flash-lite")!;
  const name = "rotated-cycle";
  await isolatedDb("rotated_cycle");
  const bound = await auditedFixture(name, "rotated-subject");
  const before = await store.target();
  for (let seq = 1; seq <= 30; seq++) {
    await db.query(`CREATE ONLY $id CONTENT { activity: $a, sequence: $seq, measurement_cycle: "f3974e8f-4c4d-41e2-af63-e4de68ea5f91", retry_index: 0, run_hash: "old", key_hash: "old", logical_hash: "old", stage: "llm-classify", provider: "openai", model: "sensenova-6.8-flash-lite", actual_model: NONE, request_id: NONE, reserved: 0, cost: NONE, state: "uncertain", usage: NONE, usage_source: "provider", price_revision: $pr, currency: "USD", started_at: time::now(), ended_at: time::now() }`, { id: new RecordId("internal_ai_attempt", `rotated-old-${seq}`), a: new RecordId("internal_ai_activity", name), seq, pr: tariff.revision });
  }
  // 新周期首个 reserve 必须延续账本而非重启：sequence=31，打上新周期标记。
  const first = await store.reserve(bound, "llm-classify", tariff, 0);
  expect(first.sequence).toBe(31);
  expect(first.measurement_cycle).toBe(MEASUREMENT_CYCLE);
  expect((await store.measurementCycle())?.attempts).toBe(1);
  // 成功 reserve → sent → settle（零费率成本 0）。
  await store.sent(first.id);
  await store.finish(first.id, { usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: null, reasoningTokens: null }, actualModel: tariff.model, requestId: "synthetic-rotated", cost: 0, failed: false });
  expect((await store.page(name, 30))[0]?.state).toBe("settled");
  // 并发预留同周期串行化：成功者的 sequence 互不重复且递增，cycle.attempts 与成功者一致。
  const batch = await Promise.allSettled(Array.from({ length: 6 }, () => store.reserve(bound, "llm-classify", tariff, 0)));
  const admitted = batch.flatMap(r => r.status === "fulfilled" ? [r.value] : []);
  expect(admitted.length).toBeGreaterThan(0);
  const sequences = admitted.map(a => a.sequence).sort((x, y) => x - y);
  expect(sequences).toEqual(Array.from({ length: admitted.length }, (_, i) => 32 + i));
  expect((await store.measurementCycle())?.attempts).toBe(1 + admitted.length);
  // measurement 分支不动 activity/target 计数：仍 0 / 旧值；页序延续旧账本。
  expect((await store.activity(name))?.attempts).toBe(0);
  expect(await store.target()).toEqual(before);
  expect((await store.page(name, 30)).map(a => a.sequence)).toEqual([31, ...sequences]);
  await db.use({ namespace: "budget_test", database: "_system" });
}, 30000);

localTest("reserve denial diagnostics classify gate vs persist failures without leaking internals", async () => {
  const tariff = TARIFFS.find(t => t.model === "sensenova-6.8-flash-lite")!;
  const name = "denial-diag", subject = "denial-subject";
  await isolatedDb("denial_diag");
  const bound = await auditedFixture(name, subject);
  const cycleId = new RecordId("internal_ai_measurement_cycle", MEASUREMENT_CYCLE);
  const warns: { reason?: string }[] = [];
  const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warns.push((args[1] ?? {}) as { reason?: string }); });
  try {
    // 证据失配：fork 把事务内 THROW 折叠成 generic failed-transaction，经探针分类为 evidence。
    await db.query('UPDATE ONLY $id SET balance_evidence_hash = $bad', { id: new RecordId("internal_ai_activity", name), bad: "0".repeat(64) });
    await expect(store.reserve(bound, "llm-classify", tariff, 0)).rejects.toThrow("internal-ai-reservation-denied");
    expect(warns.at(-1)?.reason).toBe("evidence");
    await db.query('UPDATE ONLY $id SET balance_evidence_hash = $doc', { id: new RecordId("internal_ai_activity", name), doc: "b".repeat(64) });
    // 撤销绑定：探针经绑定复核分类为 identity。
    await db.query('UPDATE internal_ai_binding SET revoked = true WHERE identity_hash = $identity', { identity: hash(subject, MEASUREMENT_DATABASE) });
    await expect(store.reserve(bound, "llm-classify", tariff, 0)).rejects.toThrow("internal-ai-reservation-denied");
    expect(warns.at(-1)?.reason).toBe("identity");
    await db.query('UPDATE internal_ai_binding SET revoked = false WHERE identity_hash = $identity', { identity: hash(subject, MEASUREMENT_DATABASE) });
    // 周期到期：expires_at 是 READONLY，删除重建到期行；外部恢复报 budget-exhausted。
    await db.query("DELETE $id", { id: cycleId });
    await db.query(`CREATE ONLY $cycle CONTENT { activity: $name, attempts: 0, attempt_limit: 30, enabled_revision: 12, approval_revision: "synthetic-test-only", evidence_hash: $docHash, expires_at: "2000-01-01T00:00:00Z", created_at: time::now() }`, { cycle: cycleId, name, docHash: "b".repeat(64) });
    await expect(store.reserve(bound, "llm-classify", tariff, 0)).rejects.toThrow("internal-ai-budget-exhausted");
    await db.query("DELETE $id", { id: cycleId });
    await db.query(`CREATE ONLY $cycle CONTENT { activity: $name, attempts: 0, attempt_limit: 30, enabled_revision: 12, approval_revision: "synthetic-test-only", evidence_hash: $docHash, expires_at: "2099-01-01T00:00:00Z", created_at: time::now() }`, { cycle: cycleId, name, docHash: "b".repeat(64) });
    // 引擎级中止（事务内唯一索引/断言等语句细节被 SDK 吞掉）：门禁全过仍失败 → persist 经探针分类。
    const flaky = new InternalAiStore(async () => ({ query: async (sql: string, vars?: Record<string, unknown>) => { if (sql.includes("BEGIN TRANSACTION")) throw new Error("The query was not executed due to a failed transaction"); return db.query(sql, vars); } }));
    await expect(flaky.reserve(bound, "llm-classify", tariff, 0)).rejects.toThrow("internal-ai-reservation-denied");
    expect(warns.at(-1)?.reason).toBe("persist");
    // 诊断不输出 subject/database/密钥等原文，只有脱敏类别与活动名。
    expect(warns.every(w => !JSON.stringify(w).includes(subject) && !JSON.stringify(w).includes(MEASUREMENT_DATABASE))).toBe(true);
  } finally { spy.mockRestore(); }
  // 提交结果未知仍保留预算不发送：事务已提交但读回失败 → 拒绝（attempt 已按预留留账）。
  const unconfirmed = new InternalAiStore(async () => ({ query: async (sql: string, vars?: Record<string, unknown>) => { const r = await db.query(sql, vars); if (sql.includes("FROM ONLY $attempt")) return []; return r; } }));
  await expect(unconfirmed.reserve(bound, "llm-classify", tariff, 0)).rejects.toThrow("internal-ai-reservation-denied");
  expect((await store.page(name)).map(a => a.state)).toEqual(["reserved"]);
  expect((await store.measurementCycle())?.attempts).toBe(1);
  await db.use({ namespace: "budget_test", database: "_system" });
}, 30000);

localTest("target cash and attempt limits are shared by separate activities and cannot reset with new run/key", async () => {
  const schema = await readFile(new URL("../../../shared/sql/system/034-internal-ai-budget.surql", import.meta.url), "utf8") + await readFile(new URL("../../../shared/sql/system/037-internal-ai-measurement-cycle.surql", import.meta.url), "utf8") + await readFile(new URL("../../../shared/sql/system/039-internal-ai-window.surql", import.meta.url), "utf8") + await readFile(new URL("../../../shared/sql/system/042-internal-ai-sampling-envelope.surql", import.meta.url), "utf8") + await readFile(new URL("../../../shared/sql/system/043-internal-ai-window-remote.surql", import.meta.url), "utf8");
  await db.query("DEFINE DATABASE IF NOT EXISTS limits_cash;"); await db.use({ namespace: "budget_test", database: "limits_cash" }); await db.query(schema);
  const t = TARIFFS[1]!;
  const a = await activity("target-a"); const b = await activity("target-b");
  // 合成历史支出fixture，只用于临界拒绝测试，绝非供应商实际成本。
  await db.query("CREATE ONLY $target SET spent = $spent", { target: new RecordId("internal_ai_target", GOAL), spent: 1000000000 - 2 * worstCost(t) });
  await store.reserve(a, "classify", t, worstCost(t)); await store.reserve(b, "proposal", t, worstCost(t));
  await expect(store.reserve({ ...a, runHash: hash("changed"), keyHash: hash("changed") }, "resume", t, worstCost(t))).rejects.toThrow();
  expect((await store.target()).reserved).toBe(2 * worstCost(t));
  await db.query("DEFINE DATABASE IF NOT EXISTS limits_attempts;"); await db.use({ namespace: "budget_test", database: "limits_attempts" }); await db.query(schema);
  const c = await activity("target-c"); const d = await activity("target-d");
  for (let i = 0; i < 30; i++) await store.reserve({ ...(i % 2 ? c : d), runHash: hash(String(i)), keyHash: hash("new-key", String(i)) }, "classify", t, worstCost(t));
  await expect(store.reserve(d, "proposal", t, worstCost(t))).rejects.toThrow();
  expect((await store.target()).attempts).toBe(30);
}, 20000);

localTest("revisionEvidence reads the string-typed revision activity so a covered cycle attempt reaches measured_derived", async () => {
  const tariff = TARIFFS.find(t => t.model === "sensenova-6.8-flash-lite")!;
  const name = "assess-evidence";
  const docHash = "c".repeat(64);
  // internal_ai_revision.activity 是 TYPE string（035 schema），必须按登记写入的真实形状造行：
  // revisionEvidence 若改用 record 链接绑定则查询恒空，周期内全部 attempt 落
  // measurement-cycle-evidence-mismatch（生产实测缺陷的回归钉）。
  await db.query(`CREATE ONLY $id CONTENT {
    activity: $name, revision: 6, state: "enabled", proof_type: "approved-service",
    goal: $goal, project: "surreal_ck", env: "test", operator: "synthetic", reason: "synthetic",
    request_task: "synthetic", manifest_hash: $docHash, document_hash: $docHash,
    configuration_digest: $docHash, identities_digest: $docHash,
    account_ref: "snv67a4f8085b59953cf4ce7af9", endpoint: $endpoint, model: $model,
    price_revision: $priceRevision, currency: "USD",
    balance_sampled_at: "2026-10-15T17:57:35.106Z", evidence_expires_at: "2026-10-15T20:37:59.000Z",
    auto_topup_disabled: true, service_approved: true, proof_expires_at: 9999999999,
    evidence_kind: "reviewed-token-plan", account_plan_type: $planType
  }`, {
    id: new RecordId("internal_ai_revision", `${name}:6`), name, goal: GOAL, docHash,
    endpoint: `https://${tariff.host}/v1`, model: tariff.model, priceRevision: tariff.revision,
    planType: TOKEN_PLAN_PLAN_TYPE_FREE,
  });
  const found = await store.revisionEvidence(name);
  expect(found.map(r => r.revision)).toEqual([6]);
  expect(found[0]?.document_hash).toBe(docHash);
  await db.query(`CREATE ONLY $cycle CONTENT { activity: $name, attempts: 1, attempt_limit: 30, enabled_revision: 6, approval_revision: "synthetic@6", evidence_hash: $docHash, expires_at: "2026-10-15T20:37:59.000Z", created_at: time::now() }`, { cycle: new RecordId("internal_ai_measurement_cycle", MEASUREMENT_CYCLE), name, docHash });
  const cycle = await store.measurementCycle();
  const ctx: AssessmentContext = {
    cycle: cycle ? { id: MEASUREMENT_CYCLE, ...cycle } : null,
    revisions: found.map(r => ({ revision: r.revision, state: r.state, createdAt: r.created_at, documentHash: r.document_hash, evidenceKind: r.evidence_kind, accountPlanType: r.account_plan_type, accountRef: r.account_ref, sampledAt: r.balance_sampled_at, expiresAt: r.evidence_expires_at, endpoint: r.endpoint, model: r.model, priceRevision: r.price_revision })),
  };
  const attempt: Attempt = { id: new RecordId("internal_ai_attempt", "assess-fixture"), sequence: 1, retry_index: 0, run_hash: hash("subject", "db", "run"), key_hash: "k", logical_hash: "l", stage: "proposal", provider: tariff.provider, model: tariff.model, actual_model: tariff.model, request_id: "synthetic", reserved: 0, cost: null, state: "uncertain", price_revision: tariff.revision, currency: "USD", measurement_cycle: MEASUREMENT_CYCLE, usage: { inputTokens: 349, outputTokens: 62, cachedInputTokens: 0, reasoningTokens: 37 }, usage_source: "provider", started_at: "2026-10-15T18:22:03.492Z", ended_at: "2026-10-15T18:22:05.531Z" };
  const assessed = assessAttempt(attempt, ctx);
  expect(assessed.status).toBe("measured_derived");
  expect(assessed.costNanoUsd).toBe(0);
});
