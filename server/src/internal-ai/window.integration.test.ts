import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { RecordId, Surreal, Table } from "surrealdb";
import type { MagpieWindowCreate } from "@surreal-ck/shared";
import { MAGPIE_B_ENVELOPE } from "@surreal-ck/shared";
import { InternalAiStore, GOAL, hash } from "./store";
import { InternalAiGate } from "./gate";
import { inInternalScope } from "./context";
import { TARIFFS, worstCost } from "./pricing";
import { WindowDenied } from "./window";

const enabled = process.env.RUN_INTERNAL_AI_FORK_TESTS === "1";
const localTest = test.skipIf(!enabled);
const binary = join(homedir(), ".surrealdb/surreal");
let directory = "";
let endpoint = "";
let child: ReturnType<typeof Bun.spawn>;
let admin: Surreal;
let schema = "";
const connections: Surreal[] = [];

beforeAll(async () => {
  if (!enabled) return;
  directory = await mkdtemp(join(tmpdir(), "magpie-window-fork-"));
  const port = await new Promise<number>((resolve, reject) => {
    const listener = createServer();
    listener.on("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const addr = listener.address();
      if (!addr || typeof addr === "string") { reject(new Error("port")); return; }
      listener.close(() => resolve(addr.port));
    });
  });
  endpoint = `ws://127.0.0.1:${port}`;
  child = Bun.spawn([binary, "start", "--no-banner", "--log", "none", "--bind", endpoint.replace("ws://", ""), "--user", "root", "--pass", "root", `rocksdb:${join(directory, "data")}`], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 80; i++) {
    const probe = Bun.spawn([binary, "is-ready", "--endpoint", endpoint], { stdout: "ignore", stderr: "ignore" });
    if (await probe.exited === 0) break;
    if (i === 79) throw new Error("fork not ready");
    await Bun.sleep(50);
  }
  admin = new Surreal();
  await admin.connect(`${endpoint}/rpc`, { authentication: { username: "root", password: "root" } });
  await admin.query("DEFINE NAMESPACE IF NOT EXISTS budget_test;");
  await admin.use({ namespace: "budget_test" });
  schema = (await Promise.all(["034-internal-ai-budget.surql", "035-internal-ai-registration.surql", "036-internal-ai-token-plan.surql", "037-internal-ai-measurement-cycle.surql", "038-internal-ai-account-plan-type.surql", "039-internal-ai-window.surql", "042-internal-ai-sampling-envelope.surql"]
    .map(async f => readFile(new URL(`../../../shared/sql/system/${f}`, import.meta.url), "utf8")))).join("\n");
}, 30000);

afterAll(async () => {
  if (!enabled) return;
  for (const connection of connections) { try { await connection.close(); } catch { /* best effort */ } }
  try { await admin.close(); } finally { child.kill(); await child.exited; }
  await rm(directory, { recursive: true, force: true });
});

async function database(name: string): Promise<{ db: Surreal; store: InternalAiStore; gate: InternalAiGate }> {
  await admin.query(`DEFINE DATABASE IF NOT EXISTS ${name};`);
  const db = new Surreal();
  await db.connect(`${endpoint}/rpc`, { authentication: { username: "root", password: "root" }, namespace: "budget_test", database: name });
  await db.query(schema);
  connections.push(db);
  const store = new InternalAiStore(async () => db);
  return { db, store, gate: new InternalAiGate(store) };
}

async function activity(db: Surreal, id: string, limits: { total?: number; per?: number } = {}) {
  await db.insert(new Table("internal_ai_activity"), {
    id: new RecordId("internal_ai_activity", id), goal: GOAL, enabled: true,
    total_limit: limits.total ?? 1_000_000_000, per_attempt_limit: limits.per ?? 100_000_000,
    attempt_limit: 30, price_revisions: [], auto_topup_disabled: true, service_approved: true,
  });
  return { activity: id, runHash: hash(id, "run"), keyHash: hash(id, "key"), logicalHash: hash(id, "key") };
}

async function history(db: Surreal, count: number): Promise<void> {
  await db.insert(new Table("internal_ai_activity"), { id: new RecordId("internal_ai_activity", "history"), goal: GOAL, enabled: true, total_limit: 1_000_000_000, per_attempt_limit: 100_000_000, attempt_limit: 30, price_revisions: [], auto_topup_disabled: true, service_approved: true });
  for (let i = 1; i <= count; i++) {
    await db.insert(new Table("internal_ai_attempt"), {
      id: new RecordId("internal_ai_attempt", `history-${i}`), activity: new RecordId("internal_ai_activity", "history"),
      sequence: i, retry_index: 0, state: i % 2 ? "uncertain" : "settled", reserved: 0,
      run_hash: "history", key_hash: "history", logical_hash: "history", stage: "chat",
      provider: "openai", model: "group/work", usage_source: "unknown", price_revision: "history",
      currency: "USD", started_at: new Date(),
    });
  }
}

const future = () => new Date(Date.now() + 3_600_000).toISOString();
const digest = (c: string) => c.repeat(64);

function windowInput(activityId: string, overrides: Partial<MagpieWindowCreate> = {}): MagpieWindowCreate {
  return {
    activity: activityId,
    approvalDigest: digest("a"),
    approvalTask: "cdc2dd4c-0000-4000-8000-000000000000",
    accountRef: "snv67a4f8085b59953cf4ce7af9",
    evidenceExpiresAt: future(),
    sourceBudgetAttempts: 1,
    sourceBudgetNanoUsd: 100_000_000,
    perAttemptNanoUsd: 10_000_000,
    route: {
      revision: "magpie-route-1", digest: digest("b"), requestedModel: "group/work",
      servedModel: "sn-sensenova-6-8-flash", endpoint: "http://127.0.0.1:3425/v1",
      accountBinding: "snv67a4f8085b59953cf4ce7af9", priceRevision: "magpie-free-1",
      priceBasis: "free-evidence", freeEvidenceHash: digest("c"), maxOutputTokens: 8192,
      sampledAt: future(), expiresAt: future(),
    },
    capacity: { database: "ws_ddad14a98469", entityTables: 4, fieldsPerTable: 12, recordsPerTable: 12, ttlSeconds: 3600, destructive: false, source: "9e44a95d" },
    idempotencyKey: `idem-${crypto.randomUUID()}`,
    reason: "integration",
    ...overrides,
  };
}

async function rejects(fn: () => Promise<unknown>, code: string): Promise<void> {
  try { await fn(); } catch (e) {
    expect(e).toBeInstanceOf(WindowDenied);
    expect((e as WindowDenied).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

localTest("historical 30 attempts reject a new window; failed and uncertain rows both count", async () => {
  const { db, store } = await database("win_full");
  await activity(db, "win-full");
  await history(db, 30);
  await rejects(() => store.createWindow(windowInput("win-full"), "ops-test"), "magpie-window-remaining-insufficient");
});

localTest("B envelope is an independent 20-attempt / 0.70 USD ledger and leaves the old 30 counter untouched", async () => {
  const { db, store } = await database("win_envelope");
  const scope = await activity(db, "win-envelope", { total: 1_000_000_000, per: 100_000_000 });
  await history(db, 30);
  const before = await store.target();
  const envelopeInput = (overrides: Partial<MagpieWindowCreate> = {}) => windowInput("win-envelope", {
    envelope: MAGPIE_B_ENVELOPE.id, sourceBudgetAttempts: 20, sourceBudgetNanoUsd: 100_000_000, perAttemptNanoUsd: 35_000_000,
    ...overrides,
  });
  const created = await store.createWindow(envelopeInput(), "ops-test");
  expect(created.window.envelope).toBe(MAGPIE_B_ENVELOPE.id);
  expect((await store.envelopeSummary())?.usedAttempts).toBe(0);
  await store.bindWindow(String(created.window.id.id), { activity: "win-envelope", expectedRevision: await store.windowRevision("win-envelope") }, "ops-test");
  for (let i = 0; i < 20; i++) {
    const ticket = await inInternalScope(scope, () => new InternalAiGate(store).begin("chat", "openai", "group/work", "http://127.0.0.1:3425/v1"));
    await new InternalAiGate(store).finish(ticket, null, null, null, true, "provider-error");
  }
  const summary = await store.envelopeSummary();
  expect(summary).toMatchObject({ usedAttempts: 20, committedAttempts: 0, remainingAttempts: 0, spentNanoUsd: 0, reservedNanoUsd: 0 });
  await expect(inInternalScope(scope, () => new InternalAiGate(store).begin("chat", "openai", "group/work", "http://127.0.0.1:3425/v1"))).rejects.toThrow("internal-ai-budget-exhausted");
  // 旧 target 的 30 次历史与计数既不被新包络清零，也不被增加。
  expect(await store.target()).toEqual(before);
  await rejects(() => store.createWindow(envelopeInput({ approvalDigest: digest("1"), idempotencyKey: "idem-env-2" }), "ops-test"), "magpie-window-remaining-insufficient");
});

localTest("B envelope paid window settles inside the envelope ledger without touching legacy counters", async () => {
  const { db, store, gate } = await database("win_envelope_paid");
  const scope = await activity(db, "win-envelope-paid");
  await history(db, 30);
  const before = await store.target();
  const openai = TARIFFS.find(t => t.revision === "openai-mini-2026-10-09")!;
  const created = await store.createWindow(windowInput("win-envelope-paid", {
    envelope: MAGPIE_B_ENVELOPE.id, sourceBudgetAttempts: 1, sourceBudgetNanoUsd: 35_000_000, perAttemptNanoUsd: 35_000_000,
    route: { ...windowInput("win-envelope-paid").route, priceBasis: "per-token", priceRevision: openai.revision, servedModel: openai.model, endpoint: "https://api.openai.com/v1", freeEvidenceHash: undefined, maxOutputTokens: 16384 },
  }), "ops-test");
  await store.bindWindow(String(created.window.id.id), { activity: "win-envelope-paid", expectedRevision: await store.windowRevision("win-envelope-paid") }, "ops-test");
  const ticket = await inInternalScope(scope, () => gate.begin("chat", "openai", "group/work", "https://api.openai.com/v1"));
  await gate.finish(ticket, { inputTokens: 1_000, outputTokens: 500, cachedInputTokens: 0, reasoningTokens: null }, openai.model, "req-envelope-paid", false);
  const [row] = await store.page("win-envelope-paid");
  expect(row).toMatchObject({ state: "settled", cost: 450_000, cost_status: "assessed", envelope: MAGPIE_B_ENVELOPE.id });
  const summary = await store.envelopeSummary();
  expect(summary).toMatchObject({ usedAttempts: 1, spentNanoUsd: 450_000, reservedNanoUsd: 0 });
  // 旧 target 账本完全不参与包络结算。
  expect(await store.target()).toEqual(before);
});

localTest("B envelope rejects expired approvals and USD overages; old prefixes still fail", async () => {
  const { db, store } = await database("win_envelope_neg");
  await activity(db, "win-envelope-neg");
  const envelopeInput = (overrides: Partial<MagpieWindowCreate> = {}) => windowInput("win-envelope-neg", {
    envelope: MAGPIE_B_ENVELOPE.id, sourceBudgetAttempts: 1, sourceBudgetNanoUsd: 35_000_000, perAttemptNanoUsd: 35_000_000, ...overrides,
  });
  await rejects(() => store.createWindow(envelopeInput({ approvalTask: "a7537d2c-3b76-42b3-bfb8-459956340984" }), "ops-test"), "magpie-window-legacy-rejected");
  await rejects(() => store.createWindow(envelopeInput({ sourceBudgetNanoUsd: 35_000_001, perAttemptNanoUsd: 35_000_001, idempotencyKey: "idem-env-usd" }), "ops-test"), "magpie-window-envelope-cap-exceeded");
  const full = await store.createWindow(envelopeInput({ sourceBudgetAttempts: 1, sourceBudgetNanoUsd: 700_000_000, idempotencyKey: "idem-env-full" }), "ops-test");
  expect(full.window.envelope).toBe(MAGPIE_B_ENVELOPE.id);
  await rejects(() => store.createWindow(envelopeInput({ approvalDigest: digest("3"), sourceBudgetAttempts: 1, sourceBudgetNanoUsd: 1, idempotencyKey: "idem-env-over" }), "ops-test"), "magpie-window-envelope-cap-exceeded");
  expect(await store.envelopeSummary()).toMatchObject({ usedAttempts: 0, committedAttempts: 1, remainingAttempts: 19 });
});

localTest("window creation is idempotent, approval-digest unique, and never re-grants remaining attempts", async () => {
  const { db, store } = await database("win_ok");
  await activity(db, "win-ok");
  await history(db, 29);
  const request = windowInput("win-ok");
  const first = await store.createWindow(request, "ops-test");
  expect(first.idempotentReplay).toBe(false);
  const replay = await store.createWindow(request, "ops-test");
  expect(replay.idempotentReplay).toBe(true);
  expect(String(replay.window.id)).toBe(String(first.window.id));
  const count = await store.window("nope");
  expect(count).toBeUndefined();
  await rejects(() => store.createWindow(windowInput("win-ok", { approvalDigest: first.window.approval_digest }), "ops-test"), "magpie-window-approval-consumed");
  await rejects(() => store.createWindow(windowInput("win-ok", { approvalDigest: digest("e") }), "ops-test"), "magpie-window-remaining-insufficient");
});

localTest("concurrent window applications reserve the same remaining budget exactly once", async () => {
  const { db, store } = await database("win_conc");
  await activity(db, "win-conc");
  await history(db, 29);
  const results = await Promise.allSettled([
    store.createWindow(windowInput("win-conc", { approvalDigest: digest("1") }), "ops-test"),
    store.createWindow(windowInput("win-conc", { approvalDigest: digest("2") }), "ops-test"),
  ]);
  expect(results.filter(r => r.status === "fulfilled").length).toBe(1);
  const windows = await db.query("SELECT * FROM internal_ai_window WHERE activity = $activity", { activity: "win-conc" });
  expect(Array.isArray(windows) && Array.isArray(windows[0]) ? (windows[0] as unknown[]).length : 0).toBe(1);
});

localTest("free-evidence window meters each request, settles zero only with valid served usage, and blocks drift/unknown cost", async () => {
  const { db, store, gate } = await database("win_free");
  const scope = await activity(db, "win-free");
  await activity(db, "win-unknown");
  const created = await store.createWindow(windowInput("win-free", { sourceBudgetAttempts: 3 }), "ops-test");
  const revision = await store.windowRevision("win-free");
  const bound = await store.bindWindow(String(created.window.id.id), { activity: "win-free", expectedRevision: revision }, "ops-test");
  expect(bound.window.status).toBe("active");
  expect(bound.idempotentReplay).toBe(false);
  const replayBind = await store.bindWindow(String(created.window.id.id), { activity: "win-free", expectedRevision: bound.activityRevision }, "ops-test");
  expect(replayBind.idempotentReplay).toBe(true);
  expect(replayBind.activityRevision).toBe(bound.activityRevision);

  const ticket = await inInternalScope(scope, () => gate.begin("chat", "openai", "group/work", "http://127.0.0.1:3425/v1"));
  expect(ticket).toBeDefined();
  const usage = { inputTokens: 50, outputTokens: 8, cachedInputTokens: null, reasoningTokens: null };
  await gate.finish(ticket, usage, "sn-sensenova-6-8-flash", "req-free-1", false);
  const [settled] = await store.page("win-free");
  expect(settled).toMatchObject({ state: "settled", cost: 0, cost_status: "free-evidence", served_model: "sn-sensenova-6-8-flash", account_binding: "snv67a4f8085b59953cf4ce7af9", route_revision: "magpie-route-1", route_digest: digest("b") });
  expect(settled?.usage_raw).toMatchObject({ inputTokens: 50, outputTokens: 8 });
  expect((await store.window(String(created.window.id.id)))?.attempts).toBe(1);

  await expect(inInternalScope(scope, () => gate.begin("chat", "openai", "group/other", "http://127.0.0.1:3425/v1"))).rejects.toThrow("internal-ai-route-drift");
  expect((await store.window(String(created.window.id.id)))?.attempts).toBe(1);

  const second = await inInternalScope(scope, () => gate.begin("chat", "openai", "group/work", "http://127.0.0.1:3425/v1"));
  await gate.finish(second, { inputTokens: 10, outputTokens: 5, cachedInputTokens: 20, reasoningTokens: null }, "sn-sensenova-6-8-flash", "req-free-2", false);
  const rows = await store.page("win-free");
  const secondRow = rows[1];
  expect(secondRow?.state).toBe("uncertain");
  expect(secondRow?.cost ?? null).toBeNull();
  expect(secondRow?.cost_status).toBe("invalid-usage");
  expect(secondRow?.route_drift).toBe(false);

  const third = await inInternalScope(scope, () => gate.begin("chat", "openai", "group/work", "http://127.0.0.1:3425/v1"));
  await gate.finish(third, null, null, null, true, "provider-error");
  const thirdRow = (await store.page("win-free"))[2];
  expect(thirdRow?.state).toBe("uncertain");
  expect(thirdRow?.cost ?? null).toBeNull();
  expect(thirdRow?.cost_status).toBe("provider-failed");
  expect(thirdRow?.route_drift).toBe(false);
  expect(thirdRow?.failure_class).toBe("provider-error");

  const unknown = await store.createWindow(windowInput("win-unknown", { approvalDigest: digest("9"), sourceBudgetAttempts: 1, route: { ...windowInput("win-unknown").route, priceBasis: "unknown", freeEvidenceHash: undefined } }), "ops-test");
  await rejectUnknown(unknown.window.id, store);
});

async function rejectUnknown(windowId: RecordId, store: InternalAiStore): Promise<void> {
  const revision = await store.windowRevision("win-unknown");
  await store.bindWindow(String(windowId.id), { activity: "win-unknown", expectedRevision: revision }, "ops-test");
  const scope = { activity: "win-unknown", runHash: hash("unknown", "run"), keyHash: hash("unknown", "key"), logicalHash: hash("unknown", "key") };
  await expect(inInternalScope(scope, () => new InternalAiGate(store).begin("chat", "openai", "group/work", "http://127.0.0.1:3425/v1"))).rejects.toThrow("internal-ai-price-unassessed");
}

localTest("per-token and subscription-amortized bases keep assessed cost and disclosure separate", async () => {
  const { db, store, gate } = await database("win_price");
  const perScope = await activity(db, "win-per");
  const openai = TARIFFS.find(t => t.revision === "openai-mini-2026-10-09")!;
  const perWindow = await store.createWindow(windowInput("win-per", {
    sourceBudgetAttempts: 1, perAttemptNanoUsd: 100_000_000, sourceBudgetNanoUsd: 100_000_000,
    route: { ...windowInput("win-per").route, priceBasis: "per-token", priceRevision: openai.revision, servedModel: openai.model, endpoint: "https://api.openai.com/v1", freeEvidenceHash: undefined, maxOutputTokens: 16384 },
  }), "ops-test");
  const perRevision = await store.windowRevision("win-per");
  await store.bindWindow(String(perWindow.window.id.id), { activity: "win-per", expectedRevision: perRevision }, "ops-test");
  const perTicket = await inInternalScope(perScope, () => gate.begin("chat", "openai", "group/work", "https://api.openai.com/v1"));
  await gate.finish(perTicket, { inputTokens: 1_000, outputTokens: 500, cachedInputTokens: 0, reasoningTokens: null }, openai.model, "req-per", false);
  const [perRow] = await store.page("win-per");
  expect(perRow).toMatchObject({ state: "settled", cost: 450_000, cost_status: "assessed" });
  expect(perRow?.reserved).toBe(worstCost(openai));

  const amortScope = await activity(db, "win-amort");
  const amortWindow = await store.createWindow(windowInput("win-amort", {
    sourceBudgetAttempts: 1, perAttemptNanoUsd: 10_000_000,
    route: { ...windowInput("win-amort").route, priceBasis: "subscription-amortized", amortizedNanoUsd: 500, marginalNanoUsd: 0, freeEvidenceHash: undefined },
  }), "ops-test");
  const amortRevision = await store.windowRevision("win-amort");
  await store.bindWindow(String(amortWindow.window.id.id), { activity: "win-amort", expectedRevision: amortRevision }, "ops-test");
  const amortTicket = await inInternalScope(amortScope, () => gate.begin("chat", "openai", "group/work", "http://127.0.0.1:3425/v1"));
  await gate.finish(amortTicket, { inputTokens: 10, outputTokens: 5, cachedInputTokens: null, reasoningTokens: null }, "sn-sensenova-6-8-flash", "req-amort", false);
  const [amortRow] = await store.page("win-amort");
  expect(amortRow?.state).toBe("uncertain");
  expect(amortRow?.cost ?? null).toBeNull();
  expect(amortRow?.cost_status).toBe("unassessed");
  expect(amortRow?.amortized_cost_nano_usd).toBe(500);
  expect(amortRow?.marginal_cost_nano_usd).toBe(0);
});

localTest("a window never lifts the global 30-attempt cap", async () => {
  const { db, store, gate } = await database("win_cap");
  const scope = await activity(db, "win-cap");
  const created = await store.createWindow(windowInput("win-cap", { sourceBudgetAttempts: 2 }), "ops-test");
  const revision = await store.windowRevision("win-cap");
  await store.bindWindow(String(created.window.id.id), { activity: "win-cap", expectedRevision: revision }, "ops-test");
  await db.query("INSERT INTO internal_ai_target { id: $id, attempts: 29, reserved: 0, spent: 0 } ON DUPLICATE KEY UPDATE attempts = 29;", { id: new RecordId("internal_ai_target", GOAL) });
  const first = await inInternalScope(scope, () => gate.begin("chat", "openai", "group/work", "http://127.0.0.1:3425/v1"));
  await gate.finish(first, { inputTokens: 1, outputTokens: 1, cachedInputTokens: null, reasoningTokens: null }, "sn-sensenova-6-8-flash", "req-cap-1", false);
  expect(await store.target()).toMatchObject({ attempts: 30 });
  await expect(inInternalScope(scope, () => gate.begin("chat", "openai", "group/work", "http://127.0.0.1:3425/v1"))).rejects.toThrow("internal-ai-budget-exhausted");
});

localTest("real-fork contract negatives: legacy prefix, expired evidence, wrong account", async () => {
  const { db, store } = await database("win_neg");
  await activity(db, "win-neg");
  const base = windowInput("win-neg");
  await rejects(() => store.createWindow({ ...base, approvalTask: "a7537d2c-3b76-42b3-bfb8-459956340984" }, "ops-test"), "magpie-window-legacy-rejected");
  await rejects(() => store.createWindow({ ...base, approvalDigest: digest("1"), evidenceExpiresAt: new Date(Date.now() - 60_000).toISOString() }, "ops-test"), "magpie-window-evidence-expired");
  await rejects(() => store.createWindow({ ...base, approvalDigest: digest("2"), accountRef: "other-account" }, "ops-test"), "magpie-window-account-mismatch");
});

localTest("expired or exhausted active windows can be replaced by a new independent approval window", async () => {
  const { db, store } = await database("win_rotate");
  await activity(db, "win-rotate");
  // evidence_expires_at 是 READONLY，只能用短证据期 + 等待来模拟自然到期。
  const first = await store.createWindow(windowInput("win-rotate", { evidenceExpiresAt: new Date(Date.now() + 1_500).toISOString() }), "ops-test");
  await store.bindWindow(String(first.window.id.id), { activity: "win-rotate", expectedRevision: await store.windowRevision("win-rotate") }, "ops-test");
  await Bun.sleep(1_700);
  const second = await store.createWindow(windowInput("win-rotate", { approvalDigest: digest("e") }), "ops-test");
  await store.bindWindow(String(second.window.id.id), { activity: "win-rotate", expectedRevision: await store.windowRevision("win-rotate") }, "ops-test");
  expect((await store.window(String(first.window.id.id)))?.status).toBe("expired");
  expect(String((await store.activity("win-rotate"))?.window_id)).toBe(String(second.window.id));

  // 耗尽：把第二窗口 attempts 直接推到上限，再用第三个独立批准窗口替换。
  await db.query("UPDATE ONLY $id SET attempts = attempt_limit", { id: second.window.id });
  const third = await store.createWindow(windowInput("win-rotate", { approvalDigest: digest("f") }), "ops-test");
  await store.bindWindow(String(third.window.id.id), { activity: "win-rotate", expectedRevision: await store.windowRevision("win-rotate") }, "ops-test");
  expect((await store.window(String(second.window.id.id)))?.status).toBe("exhausted");
  expect((await store.window(String(third.window.id.id)))?.status).toBe("active");
});
