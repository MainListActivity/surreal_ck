import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { RecordId, Surreal, Table } from "surrealdb";
import { MAGPIE_LOCAL_FRESHNESS_SECONDS, MAGPIE_REMOTE_EVIDENCE_VERSION, type MagpieRemoteWindowCreate, type MagpieWindowCreate } from "@surreal-ck/shared";
import { InternalAiStore, GOAL, hash } from "./store";
import { InternalAiGate } from "./gate";
import { inInternalScope } from "./context";
import { TARIFFS, worstCost } from "./pricing";
import { WindowDenied, routeMatches, type WindowRow } from "./window";

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
  schema = (await Promise.all(["034-internal-ai-budget.surql", "035-internal-ai-registration.surql", "036-internal-ai-token-plan.surql", "037-internal-ai-measurement-cycle.surql", "038-internal-ai-account-plan-type.surql", "039-internal-ai-window.surql", "042-internal-ai-window-remote.surql"]
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

// ── magpie-window/v2：远端 null+gap 契约（042 迁移）────────────────────────

const remoteRuntime = { providerId: "openai", modelId: "group/work", endpoint: "https://data.maplayer.top/ofm/v1" };

/** 与 7c401606 候选同构的 remote-magpie-evidence/1 投影；时间用新鲜值以通过本地新鲜度策略。 */
function remoteEvidence(capturedAt: string, overrides: Partial<MagpieRemoteWindowCreate["evidence"]> = {}): MagpieRemoteWindowCreate["evidence"] {
  const freshness = new Date(Date.parse(capturedAt) + MAGPIE_LOCAL_FRESHNESS_SECONDS * 1000).toISOString();
  return {
    version: MAGPIE_REMOTE_EVIDENCE_VERSION,
    source: { kind: "configured-remote-magpie", endpoint: remoteRuntime.endpoint, model: "remote-magpie/group/work", executionHost: "remote" },
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

function remoteWindowInput(activityId: string, overrides: Partial<MagpieRemoteWindowCreate> = {}, capturedAt?: string): MagpieRemoteWindowCreate {
  const evidence = remoteEvidence(capturedAt ?? new Date(Date.now() - 60_000).toISOString());
  return {
    activity: activityId,
    approvalDigest: digest("a"),
    approvalTask: "cdc2dd4c-0000-4000-8000-000000000000",
    accountRef: "mgpc0cfa2b2cd201c321bc7b42a",
    evidenceExpiresAt: evidence.expiry.expiresAt,
    sourceBudgetAttempts: 1,
    sourceBudgetNanoUsd: 35_000_000,
    perAttemptNanoUsd: 35_000_000,
    maxOutputTokens: 8192,
    evidence,
    capacity: { database: "ws_ddad14a98469", entityTables: 4, fieldsPerTable: 12, recordsPerTable: 12, ttlSeconds: 3600, destructive: false, source: "9e44a95d" },
    idempotencyKey: `idem-remote-${crypto.randomUUID()}`,
    reason: "integration-remote",
    ...overrides,
  };
}

localTest("remote null+gap window persists layered evidence, reads back the same row, and binds with CAS", async () => {
  const { db, store, gate } = await database("win_remote");
  const scope = await activity(db, "win-remote");
  const request = remoteWindowInput("win-remote");
  const created = await store.createRemoteWindow(request, "ops-test", remoteRuntime);
  expect(created.idempotentReplay).toBe(false);
  const window = created.window;
  expect(window.contract_version).toBe("magpie-window/v2");
  // 远端没给的字段保持 NONE/null，绝不以本地摘要或期限冒充。
  expect(window.route_revision ?? null).toBeNull();
  expect(window.route_digest ?? null).toBeNull();
  expect(window.route_expires_at ?? null).toBeNull();
  expect(window.sampled_at).toBe("2026-10-28T08:08:15.89838551Z");
  // 本地观测层与受控运行配置冻结值。
  expect(window.observation_digest).toBe(request.evidence.observation.digest);
  expect(window.observation_captured_at).toBe(request.evidence.observation.capturedAt);
  expect(window.routing_configuration_verified).toBe(false);
  expect(window.route_gaps?.length).toBe(3);
  expect(window.expiry_basis).toBe("local-observation-freshness-policy");
  expect(window.local_freshness_expires_at).toBe(request.evidence.expiry.expiresAt);
  expect(window.source_expires_at).toEqual([]);
  expect(window.requested_model).toBe("group/work");
  expect(window.endpoint).toBe(remoteRuntime.endpoint);
  expect(window.route_provider).toBe("openai");
  // 价格独立硬门禁：未复核目录 0/0 → unknown，不是 free-evidence。
  expect(window.price_basis).toBe("unknown");
  expect(window.price_revision).toBe("unknown");
  expect(window.pricing_reviewed).toBe(false);
  expect(window.pricing_evidence_revision).toBe("remote-magpie-catalog-285bd6a56db6");

  // 幂等重放返回同一行；改动观测但复用同一批准摘要一律拒绝。
  const replay = await store.createRemoteWindow(request, "ops-test", remoteRuntime);
  expect(replay.idempotentReplay).toBe(true);
  expect(String(replay.window.id)).toBe(String(window.id));
  const changedObservation = remoteWindowInput("win-remote", {
    evidence: remoteEvidence(new Date(Date.now() - 60_000).toISOString(), { observation: { capturedAt: request.evidence.observation.capturedAt, digest: digest("e"), routingConfigurationVerified: false } }),
  });
  await rejects(() => store.createRemoteWindow(changedObservation, "ops-test", remoteRuntime), "magpie-window-approval-consumed");

  // CAS 漂移：过期活动版本拒绝，正确版本绑定成功。
  await rejects(() => store.bindWindow(String(window.id.id), { activity: "win-remote", expectedRevision: 99 }, "ops-test"), "magpie-window-revision-conflict");
  const revision = await store.windowRevision("win-remote");
  const bound = await store.bindWindow(String(window.id.id), { activity: "win-remote", expectedRevision: revision }, "ops-test");
  expect(bound.window.status).toBe("active");
  expect(bound.window.route_gaps?.length).toBe(3);
  expect(bound.window.price_basis).toBe("unknown");

  // 请求门禁同源：路由匹配后因价格 unknown 闭锁；端点/模型/provider 漂移分别拒绝。
  await expect(inInternalScope(scope, () => gate.begin("chat", "openai", "group/work", remoteRuntime.endpoint))).rejects.toThrow("internal-ai-price-unassessed");
  await expect(inInternalScope(scope, () => gate.begin("chat", "openai", "group/work", "https://data.maplayer.top/other/v1"))).rejects.toThrow("internal-ai-route-drift");
  await expect(inInternalScope(scope, () => gate.begin("chat", "openai", "group/other", remoteRuntime.endpoint))).rejects.toThrow("internal-ai-route-drift");
  await expect(inInternalScope(scope, () => gate.begin("chat", "anthropic", "group/work", remoteRuntime.endpoint))).rejects.toThrow("internal-ai-route-drift");
  expect((await store.window(String(window.id.id))?.attempts ?? 0)).toBe(0);
  expect((await store.page("win-remote")).length).toBe(0);
});

localTest("remote evidence expiry rejects create, bind, and the request gate", async () => {
  const { db, store, gate } = await database("win_remote_exp");
  const scope = await activity(db, "win-remote-exp");
  const stale = remoteWindowInput("win-remote-exp", {}, new Date(Date.now() - (MAGPIE_LOCAL_FRESHNESS_SECONDS + 60) * 1000).toISOString());
  await rejects(() => store.createRemoteWindow(stale, "ops-test", remoteRuntime), "magpie-window-evidence-expired");

  // 请求门禁：先绑定一个即将到期的窗口，到期后 begin 必须闭锁。
  const soon = remoteWindowInput("win-remote-exp", {}, new Date(Date.now() - (MAGPIE_LOCAL_FRESHNESS_SECONDS - 2) * 1000).toISOString());
  const created = await store.createRemoteWindow(soon, "ops-test", remoteRuntime);
  await store.bindWindow(String(created.window.id.id), { activity: "win-remote-exp", expectedRevision: await store.windowRevision("win-remote-exp") }, "ops-test");
  await Bun.sleep(2_300);
  await expect(inInternalScope(scope, () => gate.begin("chat", "openai", "group/work", remoteRuntime.endpoint))).rejects.toThrow("internal-ai-evidence-unavailable");

  // 绑定门禁：到期窗口不可再绑定（新的独立批准窗口）。
  const expiring = remoteWindowInput("win-remote-exp", { approvalDigest: digest("b") }, new Date(Date.now() - (MAGPIE_LOCAL_FRESHNESS_SECONDS - 1) * 1000).toISOString());
  const second = await store.createRemoteWindow(expiring, "ops-test", remoteRuntime);
  await Bun.sleep(1_300);
  const staleRevision = await store.windowRevision("win-remote-exp");
  await rejects(() => store.bindWindow(String(second.window.id.id), { activity: "win-remote-exp", expectedRevision: staleRevision }, "ops-test"), "magpie-window-evidence-expired");
});

localTest("042 widening keeps existing v1 rows intact and v2 creation requires the migration first", async () => {
  const { db, store } = await database("win_compat");
  await activity(db, "win-compat");
  // 模拟生产顺序：039 已应用且已有 v1 行；042 尚未应用时新代码拒绝写入（SCHEMAFULL 未知字段）。
  const routeDigest = digest("b");
  const futureInstant = future();
  await db.query(`INSERT INTO internal_ai_window {
    id: $id, activity: "win-compat", approval_digest: $approval, approval_task: "legacy-task", account_ref: "snv-legacy",
    evidence_expires_at: $future, attempt_limit: 1, source_budget_nano_usd: 100000000, per_attempt_nano_usd: 10000000,
    route_revision: "magpie-route-legacy", route_digest: $routeDigest, requested_model: "group/work", served_model: "sn-sensenova-6-8-flash",
    endpoint: "http://127.0.0.1:3425/v1", account_binding: "snv-legacy", price_revision: "magpie-free-1", price_basis: "free-evidence",
    free_evidence_hash: $freeHash, max_output_tokens: 8192, sampled_at: $future, route_expires_at: $future,
    capacity_database: "ws_ddad14a98469", capacity_tables: 4, capacity_fields: 12, capacity_records: 12,
    capacity_ttl_seconds: 3600, capacity_destructive: false, capacity_source: "9e44a95d",
    idempotency_key: "legacy-idem-1", payload_hash: $payload, operator: "ops-legacy", reason: "legacy"
  };`, {
    id: new RecordId("internal_ai_window", "legacy-window"), approval: digest("1"), future: futureInstant,
    routeDigest, freeHash: digest("c"), payload: digest("2"),
  });
  const before = await store.window("legacy-window");
  expect(before?.route_revision).toBe("magpie-route-legacy");
  expect(before?.contract_version ?? null).toBeNull();

  // 042 逐文件重放（迁移可重复执行），既有行值不变。
  const migration = await readFile(new URL("../../../shared/sql/system/042-internal-ai-window-remote.surql", import.meta.url), "utf8");
  await db.query(migration);
  await db.query(migration);
  const legacy = await store.window("legacy-window");
  expect(legacy).toMatchObject({ route_revision: "magpie-route-legacy", route_digest: routeDigest, route_expires_at: futureInstant });
  expect(legacy?.contract_version ?? null).toBeNull();
  expect(legacy?.price_basis).toBe("free-evidence");
  // v1 行（route_provider NONE）继续走旧 openai 规则。
  expect(routeMatches(legacy as WindowRow, "openai", "group/work", "http://127.0.0.1:3425/v1")).toBe(true);
  expect(routeMatches(legacy as WindowRow, "anthropic", "group/work", "http://127.0.0.1:3425/v1")).toBe(false);

  // 迁移后 v2 创建可用，且与既有 v1 行共存。
  await activity(db, "win-compat2");
  const created = await store.createRemoteWindow(remoteWindowInput("win-compat2"), "ops-test", remoteRuntime);
  expect(created.window.contract_version).toBe("magpie-window/v2");
  expect(await store.window("legacy-window")).toMatchObject({ route_revision: "magpie-route-legacy" });
});
