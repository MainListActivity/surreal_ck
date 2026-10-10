import { ModelRouterLanguageModel } from "@mastra/core/llm";
import { InternalBudgetModel } from "./model";
import { createOpenAiCompatibleEmbeddingProvider } from "../resources/embedding-provider";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { RecordId, Surreal, Table } from "surrealdb";
import { InternalAiStore, GOAL, hash } from "./store";
import { InternalAiGate } from "./gate";
import { TARIFFS, worstCost } from "./pricing";
import { inInternalScope } from "./context";
import { meteredDecision } from "./decision";
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
  await db.insert(new Table("internal_ai_activity"), { id: new RecordId("internal_ai_activity", id), goal: GOAL, enabled: true, total_limit: 1000000000, per_attempt_limit: 100000000, attempt_limit: 30, approval_revision: "synthetic-test-only", evidence_expires_at: "2099-01-01T00:00:00Z", price_revisions: [tariff.revision], evidence_kind: "reviewed-token-plan", plan_name: "SenseNova Token Plan 公测", plan_source_url: "https://www.sensenova.cn/token-plan", quota_unit: "points", quota_amount: 60000, quota_window_seconds: 18000, quota_remaining: 60000, no_payment_instrument: true, balance_source: `token-plan:${"b".repeat(64)}`, balance_sampled_at: "2026-10-09T00:00:00Z", balance_evidence_hash: "b".repeat(64), auto_topup_disabled: true, service_approved: true });
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
  // 配额型证据缺失、出处前缀错误、夹带 USD 余额、价目版本不符、非零金额预留：全部 fail-closed。
  for (const [id, mutate] of [
    ["tp-exhausted", "quota_remaining = 0"],
    ["tp-missing-plan", "plan_name = NONE"],
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

localTest("target cash and attempt limits are shared by separate activities and cannot reset with new run/key", async () => {
  const schema = await readFile(new URL("../../../shared/sql/system/034-internal-ai-budget.surql", import.meta.url), "utf8");
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
