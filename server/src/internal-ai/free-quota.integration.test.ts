import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { RecordId, Surreal, Table } from "surrealdb";
import {
  MAGPIE_B_ENVELOPE, MAGPIE_FREE_BASIS_DECISION, MAGPIE_FREE_BASIS_ROUTE, MAGPIE_FREE_BASIS_VERSION,
  MAGPIE_LOCAL_FRESHNESS_SECONDS, MAGPIE_REMOTE_EVIDENCE_VERSION,
  type MagpieFreeQuotaBasis, type MagpieFreeQuotaRemoteWindowCreate, type MagpieWindowCreate,
} from "@surreal-ck/shared";
import { InternalAiStore, GOAL, hash } from "./store";
import { InternalAiGate } from "./gate";
import { inInternalScope } from "./context";
import { TARIFFS } from "./pricing";
import { freeQuotaBasisContent, freeQuotaBasisHash } from "./free-quota";
import { WindowDenied } from "./window";

const enabled = process.env.RUN_INTERNAL_AI_FORK_TESTS === "1";
/** 每个用例都新建数据库并重放 034–044 迁移，单用例超时统一放宽到 60 秒（默认 5 秒不足以覆盖重放）。 */
const localTest = (name: string, fn: () => Promise<void>) => test.skipIf(!enabled)(name, fn, 60_000);
const binary = join(homedir(), ".surrealdb/surreal");
let directory = "";
let endpoint = "";
let child: ReturnType<typeof Bun.spawn>;
let admin: Surreal;
let schema = "";
const connections: Surreal[] = [];

beforeAll(async () => {
  if (!enabled) return;
  directory = await mkdtemp(join(tmpdir(), "magpie-free-quota-fork-"));
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
  schema = (await Promise.all(["034-internal-ai-budget.surql", "035-internal-ai-registration.surql", "036-internal-ai-token-plan.surql", "037-internal-ai-measurement-cycle.surql", "038-internal-ai-account-plan-type.surql", "039-internal-ai-window.surql", "042-internal-ai-sampling-envelope.surql", "043-internal-ai-window-remote.surql", "044-internal-ai-free-quota-basis.surql"]
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

async function activity(db: Surreal, id: string) {
  await db.insert(new Table("internal_ai_activity"), {
    id: new RecordId("internal_ai_activity", id), goal: GOAL, enabled: true,
    total_limit: 1_000_000_000, per_attempt_limit: 100_000_000,
    attempt_limit: 30, price_revisions: [], auto_topup_disabled: true, service_approved: true,
  });
  return { activity: id, runHash: hash(id, "run"), keyHash: hash(id, "key"), logicalHash: hash(id, "key") };
}

async function rejects(fn: () => Promise<unknown>, code: string): Promise<void> {
  try { await fn(); } catch (e) {
    expect(e).toBeInstanceOf(WindowDenied);
    expect((e as WindowDenied).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

/** 数据库语句应失败且消息匹配；直接 await 查询，不用 expect().rejects 包裹 SDK 惰性查询对象（否则用例挂起）。 */
async function fails(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try { await fn(); } catch (e) {
    expect((e as Error).message).toMatch(pattern);
    return;
  }
  throw new Error(`expected a failure matching ${pattern}`);
}

const digest = (c: string) => c.repeat(64);
const future = () => new Date(Date.now() + 3_600_000).toISOString();

/** 与 free-quota.test.ts 同源的依据内容：老板决定 → 固定路由 → B 包络，到期取包络期限。 */
function basis(overrides: Partial<MagpieFreeQuotaBasis> = {}): MagpieFreeQuotaBasis {
  return {
    version: MAGPIE_FREE_BASIS_VERSION,
    decision: { ...MAGPIE_FREE_BASIS_DECISION },
    route: { ...MAGPIE_FREE_BASIS_ROUTE },
    envelope: MAGPIE_B_ENVELOPE.id,
    effectiveAt: "2026-10-30T22:00:00Z",
    expiresAt: MAGPIE_B_ENVELOPE.expiresAt,
    ...overrides,
  };
}

const remoteRuntime = { providerId: "openai", modelId: "group/work", endpoint: "https://data.maplayer.top/ofm/v1" };

/** 远端 null+gap 证据（与 window.integration 同构）；采集时刻由调用方给出。 */
function remoteEvidence(capturedAt: string): MagpieFreeQuotaRemoteWindowCreate["evidence"] {
  const freshness = new Date(Date.parse(capturedAt) + MAGPIE_LOCAL_FRESHNESS_SECONDS * 1000).toISOString();
  return {
    version: MAGPIE_REMOTE_EVIDENCE_VERSION,
    source: { kind: "configured-remote-magpie", endpoint: remoteRuntime.endpoint, model: "remote-magpie/group/work", executionHost: "remote" },
    observation: { capturedAt, digest: digest("d"), routingConfigurationVerified: false },
    accountRef: "mgpc0cfa2b2cd201c321bc7b42a",
    accountBinding: "mgpc0cfa2b2cd201c321bc7b42a",
    route: {
      present: true, group: "group/work", revision: null, digest: null,
      servedModel: MAGPIE_FREE_BASIS_ROUTE.servedModel, sampledAt: "2026-10-28T08:08:15.89838551Z", expiresAt: null,
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
  };
}

function freeRemoteInput(activityId: string, freeHash: string, overrides: Partial<MagpieFreeQuotaRemoteWindowCreate> = {}, capturedAt?: string): MagpieFreeQuotaRemoteWindowCreate {
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
    idempotencyKey: `idem-free-${activityId}`,
    reason: "integration-free",
    envelope: MAGPIE_B_ENVELOPE.id,
    freeQuotaBasisHash: freeHash,
    ...overrides,
  };
}

/** 非 B 档 v1 免费窗口输入，用于验证停止后的绑定封堵。 */
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

/** B 档付费窗口（per-token 已核证书），用于验证停止后 B 包络整体关闭、不回落付费。 */
const openaiMini = TARIFFS.find(t => t.revision === "openai-mini-2026-10-09")!;
function paidEnvelopeInput(activityId: string, overrides: Partial<MagpieWindowCreate> = {}): MagpieWindowCreate {
  return windowInput(activityId, {
    envelope: MAGPIE_B_ENVELOPE.id, sourceBudgetAttempts: 1, sourceBudgetNanoUsd: 35_000_000, perAttemptNanoUsd: 35_000_000,
    route: {
      ...windowInput(activityId).route, priceBasis: "per-token", priceRevision: openaiMini.revision, servedModel: openaiMini.model,
      endpoint: "https://api.openai.com/v1", freeEvidenceHash: undefined, maxOutputTokens: 16384,
    },
    ...overrides,
  });
}

/** 创建并绑定一个 v3 免费窗口，返回窗口 id 字符串。 */
async function boundFreeWindow(store: InternalAiStore, activityId: string, freeHash: string, overrides: Partial<MagpieFreeQuotaRemoteWindowCreate> = {}, capturedAt?: string): Promise<string> {
  const created = await store.createFreeQuotaRemoteWindow(freeRemoteInput(activityId, freeHash, overrides, capturedAt), "ops-test", remoteRuntime);
  await store.bindWindow(String(created.window.id.id), { activity: activityId, expectedRevision: await store.windowRevision(activityId) }, "ops-test");
  return String(created.window.id.id);
}

localTest("free-quota basis is content-addressed: create, replay and read back; stored edits are refused", async () => {
  const { db, store } = await database("fq_basis");
  const content = basis();
  const created = await store.createFreeQuotaBasis({ basis: content, reason: "integration" }, "ops-test");
  expect(created.hash).toBe(freeQuotaBasisHash(content));
  expect(created.idempotentReplay).toBe(false);
  const replay = await store.createFreeQuotaBasis({ basis: content, reason: "integration" }, "ops-test");
  expect(replay).toMatchObject({ hash: created.hash, idempotentReplay: true });
  expect(await store.freeQuotaBasis(created.hash)).toEqual(content);
  expect(await store.freeQuotaBasis(digest("0"))).toBeNull();
  // 内容字段为只读：数据库层即拒绝改写，依据记录不可变。
  const changed = freeQuotaBasisContent(content).replace(MAGPIE_FREE_BASIS_ROUTE.servedModel, "other-model");
  await fails(() => db.query("UPDATE ONLY $id SET content = $content", { id: new RecordId("internal_ai_free_basis", created.hash), content: changed }), /readonly/);
  // 绕过只读的外部写入：记录 id 与内容 hash 不一致，读回复算即拒绝。
  const forge = (recordHash: string, text: string) => db.query("CREATE ONLY $id CONTENT $row", {
    id: new RecordId("internal_ai_free_basis", recordHash),
    row: {
      content: text, route_host: MAGPIE_FREE_BASIS_ROUTE.host, route_path: MAGPIE_FREE_BASIS_ROUTE.path,
      route_served_model: MAGPIE_FREE_BASIS_ROUTE.servedModel, envelope: MAGPIE_B_ENVELOPE.id,
      effective_at: content.effectiveAt, expires_at: content.expiresAt, operator: "ops-test", reason: "forged",
    },
  });
  await forge(digest("9"), freeQuotaBasisContent(content));
  await rejects(() => store.freeQuotaBasis(digest("9")), "magpie-window-free-basis-invalid");
  // 篡改内容并以其自身 hash 落库：复算一致，但固定字面量的 schema 拒绝其它服务模型。
  const forged = { ...content, route: { ...content.route, servedModel: "other-model" } } as MagpieFreeQuotaBasis;
  await forge(freeQuotaBasisHash(forged), freeQuotaBasisContent(forged));
  await rejects(() => store.freeQuotaBasis(freeQuotaBasisHash(forged)), "magpie-window-free-basis-invalid");
});

localTest("a v3 window needs a stored basis and takes its route and price from it, inside the B envelope", async () => {
  const { db, store } = await database("fq_create");
  await activity(db, "fq-create");
  const content = basis();
  const freeHash = freeQuotaBasisHash(content);
  await rejects(() => store.createFreeQuotaRemoteWindow(freeRemoteInput("fq-create", digest("8")), "ops-test", remoteRuntime), "magpie-window-free-basis-unknown");
  await store.createFreeQuotaBasis({ basis: content, reason: "integration" }, "ops-test");
  const input = freeRemoteInput("fq-create", freeHash);
  const created = await store.createFreeQuotaRemoteWindow(input, "ops-test", remoteRuntime);
  expect(created.idempotentReplay).toBe(false);
  expect(created.window).toMatchObject({
    contract_version: "magpie-window/v3", envelope: MAGPIE_B_ENVELOPE.id, price_basis: "free-evidence",
    free_evidence_hash: freeHash, route_provider: "openai", endpoint: remoteRuntime.endpoint, status: "active",
    price_revision: `${MAGPIE_FREE_BASIS_VERSION}:${freeHash}`,
  });
  const replay = await store.createFreeQuotaRemoteWindow(input, "ops-test", remoteRuntime);
  expect(replay.idempotentReplay).toBe(true);
  expect(String(replay.window.id)).toBe(String(created.window.id));
  // 实时口径：一个活动窗口即承诺 1 次与 0.035 USD，且计入 B 包络而非旧 30 次账本。
  expect(await store.envelopeSummary()).toMatchObject({ usedAttempts: 0, committedAttempts: 1, remainingAttempts: 19, committedNanoUsd: 35_000_000 });
});

localTest("begin stops a v3 window whose basis expired: terminal stopped, no retry, and the envelope closes", async () => {
  const { db, store, gate } = await database("fq_expiry");
  const scope = await activity(db, "fq-expiry");
  await activity(db, "fq-expiry-b");
  const t0 = Date.now();
  // 依据 3s 后到期；证据期 = 采集 + 7200s，采集取 7198s 前，证据期约 2s 后到期，因此不越过依据期限。
  const content = basis({ expiresAt: new Date(t0 + 3_000).toISOString() });
  await store.createFreeQuotaBasis({ basis: content, reason: "integration" }, "ops-test");
  const windowId = await boundFreeWindow(store, "fq-expiry", freeQuotaBasisHash(content), {}, new Date(t0 - (MAGPIE_LOCAL_FRESHNESS_SECONDS - 2) * 1000).toISOString());
  await Bun.sleep(3_300);
  await expect(inInternalScope(scope, () => gate.begin("chat", "openai", "group/work", remoteRuntime.endpoint))).rejects.toThrow("internal-ai-free-quota-stopped");
  expect(await store.window(windowId)).toMatchObject({ status: "stopped", stop_reason: "free-basis-expired" });
  await expect(inInternalScope(scope, () => gate.begin("chat", "openai", "group/work", remoteRuntime.endpoint))).rejects.toThrow("internal-ai-free-quota-stopped");
  expect(await store.envelopeFreeStopped()).toBe(true);
  await rejects(() => store.createWindow(paidEnvelopeInput("fq-expiry-b"), "ops-test"), "magpie-window-free-quota-stopped");
});

localTest("a route drift stops the v3 window, closes the envelope, and refuses binding any other window", async () => {
  const { db, store, gate } = await database("fq_drift");
  const scope = await activity(db, "fq-drift");
  await activity(db, "fq-drift-other");
  const content = basis();
  await store.createFreeQuotaBasis({ basis: content, reason: "integration" }, "ops-test");
  const windowId = await boundFreeWindow(store, "fq-drift", freeQuotaBasisHash(content));
  await expect(inInternalScope(scope, () => gate.begin("chat", "openai", "group/other", remoteRuntime.endpoint))).rejects.toThrow("internal-ai-free-quota-stopped");
  expect(await store.window(windowId)).toMatchObject({ status: "stopped", stop_reason: "route-drift" });
  // 停止后：B 包络不再接受付费或新免费窗口，也不允许把任何窗口（含非 B 窗口）绑定到活动上。
  await rejects(() => store.createWindow(paidEnvelopeInput("fq-drift-other"), "ops-test"), "magpie-window-free-quota-stopped");
  const plain = await store.createWindow(windowInput("fq-drift-other", { approvalDigest: digest("e") }), "ops-test");
  const plainRevision = await store.windowRevision("fq-drift-other");
  await rejects(() => store.bindWindow(String(plain.window.id.id), { activity: "fq-drift-other", expectedRevision: plainRevision }, "ops-test"), "magpie-window-free-quota-stopped");
});

localTest("a provider 402 stops the window and the same transaction closes the envelope's other active windows", async () => {
  const { db, store, gate } = await database("fq_billing");
  const scope = await activity(db, "fq-billing");
  await activity(db, "fq-billing-sibling");
  const content = basis();
  const freeHash = freeQuotaBasisHash(content);
  await store.createFreeQuotaBasis({ basis: content, reason: "integration" }, "ops-test");
  const firstId = await boundFreeWindow(store, "fq-billing", freeHash);
  const siblingCreated = await store.createFreeQuotaRemoteWindow(freeRemoteInput("fq-billing-sibling", freeHash, { approvalDigest: digest("b") }), "ops-test", remoteRuntime);
  const siblingId = String(siblingCreated.window.id.id);
  const ticket = await inInternalScope(scope, () => gate.begin("chat", "openai", "group/work", remoteRuntime.endpoint));
  await gate.finish(ticket, null, null, null, true, "provider-error", { statusCode: 402 });
  expect(await store.window(firstId)).toMatchObject({ status: "stopped", stop_reason: "billing-required" });
  expect(await store.window(siblingId)).toMatchObject({ status: "stopped", stop_reason: "billing-required" });
  const [row] = await store.page("fq-billing");
  expect(row).toMatchObject({ state: "uncertain", failure_class: "provider-error", cost_status: "provider-failed" });
  expect(row?.cost ?? null).toBeNull();
  await expect(inInternalScope(scope, () => gate.begin("chat", "openai", "group/work", remoteRuntime.endpoint))).rejects.toThrow("internal-ai-free-quota-stopped");
  expect((await store.envelopeSummary())?.usedAttempts).toBe(1);
});

localTest("missing usage stops the window while the request stays metered; valid usage keeps it active", async () => {
  const { db, store, gate } = await database("fq_usage");
  const scope = await activity(db, "fq-usage");
  const content = basis();
  await store.createFreeQuotaBasis({ basis: content, reason: "integration" }, "ops-test");
  const created = await store.createFreeQuotaRemoteWindow(freeRemoteInput("fq-usage", freeQuotaBasisHash(content), { sourceBudgetAttempts: 3 }), "ops-test", remoteRuntime);
  const windowId = String(created.window.id.id);
  await store.bindWindow(windowId, { activity: "fq-usage", expectedRevision: await store.windowRevision("fq-usage") }, "ops-test");

  const first = await inInternalScope(scope, () => gate.begin("chat", "openai", "group/work", remoteRuntime.endpoint));
  await gate.finish(first, { inputTokens: 50, outputTokens: 8, cachedInputTokens: null, reasoningTokens: null }, MAGPIE_FREE_BASIS_ROUTE.servedModel, "req-free-1", false);
  expect(await store.window(windowId)).toMatchObject({ status: "active", attempts: 1 });
  const [settled] = await store.page("fq-usage");
  expect(settled).toMatchObject({ state: "settled", cost: 0, cost_status: "free-evidence" });

  // served model 与依据一致、usage 缺失 → usage-missing 停止；served model 缺失本身按漂移处理（先于 usage 判定）。
  const second = await inInternalScope(scope, () => gate.begin("chat", "openai", "group/work", remoteRuntime.endpoint));
  await gate.finish(second, null, MAGPIE_FREE_BASIS_ROUTE.servedModel, "req-free-2", false);
  expect(await store.window(windowId)).toMatchObject({ status: "stopped", stop_reason: "usage-missing", attempts: 2 });
  const rows = await store.page("fq-usage");
  expect(rows[1]).toMatchObject({ state: "uncertain", cost_status: "usage-missing" });
  expect(rows[1]?.cost ?? null).toBeNull();
  await expect(inInternalScope(scope, () => gate.begin("chat", "openai", "group/work", remoteRuntime.endpoint))).rejects.toThrow("internal-ai-free-quota-stopped");
});
