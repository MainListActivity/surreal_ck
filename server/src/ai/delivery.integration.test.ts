import { beforeAll, afterAll, test, expect } from "bun:test";
import { loadPlatformContentScripts } from "@surreal-ck/shared/platform-content-schema";
import type { ContentResearchSessionFactory } from "../research/window";
import { Hono } from "hono";
import { Surreal, StringRecordId } from "surrealdb";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { createDefaultAiContextSnapshot, type ChatStreamEvent } from "@surreal-ck/shared";
import { ChatDeliveryStore, requestDigest, authorizeDelivery, type DeliveryPlatformVerifier } from "./delivery-store";
import { createDeliveryVerifierFactory } from "./delivery-verify";
import { createRunBus } from "./run-bus";
import { createRunRegistry } from "./run-registry";
import { createAiChatService, type ChatRunner } from "./chat-service";
import { createAiChatRoutes, type AiAllowanceGate } from "../routes/ai-chat";
import { AiAllowanceService, type Queryable } from "../ai-allowance/service";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";

const local = test.skipIf(process.env.RUN_LOCAL_SURREALDB_TESTS !== "1");
const url = process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:18895/rpc";
const db = `chat_delivery_${Date.now().toString(36)}`;
const root = new Surreal();
const connections: Surreal[] = [];
const key = "11".repeat(32); // isolated test key, never a deployment credential
const store = new ChatDeliveryStore(key);
const context = createDefaultAiContextSnapshot();
let allowance: AiAllowanceService;
let subject = "member";

async function caller() {
  const session = new Surreal(); connections.push(session);
  await session.connect(url, { namespace: "d1_test", database: db });
  await session.signin({ namespace: "d1_test", database: db, access: "test_member", variables: { subject } });
  return session;
}
function makeApp(runner: ChatRunner, opts: { registry?: ReturnType<typeof createRunRegistry>; maxRunMs?: number; content?: ContentResearchSessionFactory; verifier?: (user: AppBindings["Variables"]["user"]) => DeliveryPlatformVerifier; saveDelayMs?: number; settleDelayMs?: number } = {}) {
  const bus = createRunBus();
  const registry = opts.registry ?? createRunRegistry();
  const service = createAiChatService({ runBus: bus, runner, maxRunMs: opts.maxRunMs });
  const gate: AiAllowanceGate = opts.settleDelayMs ? {
    reserve: (input) => allowance.reserve(input),
    async finishByRun(input) {
      await new Promise(resolve => setTimeout(resolve, opts.settleDelayMs));
      return allowance.finishByRun(input);
    },
  } : allowance;
  const deliveries: ChatDeliveryStore = opts.saveDelayMs === undefined ? store : {
    claim: (session, input) => store.claim(session, input),
    find: (session, runId) => store.find(session, runId),
    read: (session, runId) => store.read(session, runId),
    save: async (session, database, subject, payload) => { await new Promise(resolve => setTimeout(resolve, opts.saveDelayMs)); return store.save(session, database, subject, payload); },
    decrypt: (row, database, subject) => store.decrypt(row, database, subject),
    status: (session, runId, status) => store.status(session, runId, status),
  };
  const app = new Hono<AppBindings>().onError((error, c) => { return c.json({ code: error instanceof HttpError ? error.code : "internal" }, error instanceof HttpError ? error.status : 500); });
  app.route("/", createAiChatRoutes({ service, registry, deliveries, allowance: gate,
    createCallerSession: caller, createContentResearchSession: opts.content, createDeliveryVerifier: opts.verifier,
    rolloutGates: async () => "enabled",
    requireUser: () => async (c, next) => {
      c.set("user", { subject, rawToken: "local-fixture-token", raw: { db, exp: Math.floor(Date.now() / 1000) + 3600 } } as AppBindings["Variables"]["user"]);
      await next();
    },
  }));
  const post = (path: string, body?: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { bus, post, registry };
}
async function until(fn: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("terminal did not arrive");
}
async function ledger(runId: string) {
  return (await root.query<[Array<{ kind: string; amount: number }>]>(`SELECT kind, amount FROM ai_ledger_entry WHERE reservation.run_id = $run;`, { run: runId }))[0];
}

beforeAll(async () => {
  if (process.env.RUN_LOCAL_SURREALDB_TESTS !== "1") return;
  await root.connect(url, { authentication: { username: "root", password: "root" }, namespace: "d1_test", database: db });
  for (const script of await loadTemplateScripts({ oidcJwksUrl: "https://fixture.test/jwks" })) await root.query(script.sql);
  await root.query(`CREATE user:member CONTENT { subject: "member", kind: "human", email: "member@fixture.test", is_admin: false };
    CREATE user:other CONTENT { subject: "other", kind: "human", email: "other@fixture.test", is_admin: false };
    DEFINE ACCESS test_member ON DATABASE TYPE RECORD SIGNIN (SELECT * FROM user WHERE subject = $subject AND kind = "human") DURATION FOR SESSION 1h;`);
  const system: Queryable = { query: async sql => sql.includes("current_product_entitlement")
    // LCA14 D2 口径：plan_cycle 桶只在权益窗口有效（effective_from <= now < effective_until）时对应当前商业来源。
    ? [[{ ai_actions: ["research"], base_kind: "subscription", base_id: "fixture",
      effective_from: new Date(Date.now() - 60_000).toISOString(), effective_until: new Date(Date.now() + 3_600_000).toISOString() }]] : [[{ db_name: db }]] };
  allowance = new AiAllowanceService({ workspaceSession: async () => root, systemSession: async () => system });
  await allowance.grant({ db, kind: "plan_cycle", amount: 100, label: "D1 fixture", periodKey: "subscription:fixture:cycle",
    effectiveFrom: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 3600000), operatorSubject: "fixture" });
});
afterAll(async () => { await Promise.allSettled(connections.map(c => c.close())); await root.close(); });

local("HTTP concurrent retry, disconnected delivery, process restart recovery and real reserve/settle stay single", async () => {
  let invocations = 0;
  let resolve!: () => void;
  const held = new Promise<void>(r => { resolve = r; });
  const h = makeApp(async input => {
    invocations++;
    await held;
    input.pushChunk({ streamId: input.streamId, type: "done", message: { id: "answer", role: "assistant", content: "AUTHORIZED_D1_RESULT", context, createdAt: new Date().toISOString() }, toolCalls: [] });
    return { runId: input.runId, finalText: "AUTHORIZED_D1_RESULT", status: "success" };
  });
  const first = await h.post("/api/chat", { message: "fixture research", idempotencyKey: "concurrent" });
  expect(first.status).toBe(200);
  const start = await first.json() as { runId: string };
  const retries = await Promise.all(Array.from({ length: 3 }, () => h.post("/api/chat", { message: "fixture research", idempotencyKey: "concurrent" })));
  for (const retry of retries) { expect(retry.status).toBe(200); expect((await retry.json()).runId).toBe(start.runId); }
  expect(invocations).toBe(1);
  // No active WS subscribers. Completion must still become durably recoverable before settle.
  resolve();
  await until(async () => (await ledger(start.runId)).some(e => e.kind === "settle"));
  const restarted = makeApp(async () => { throw new Error("recovery must not execute a model"); });
  const recovered = await restarted.post(`/api/chat/runs/${start.runId}/recover`);
  expect(recovered.status).toBe(200);
  expect((await recovered.json()).result.message.content).toBe("AUTHORIZED_D1_RESULT");
  await restarted.post(`/api/chat/runs/${start.runId}/recover`);
  const entries = await ledger(start.runId);
  expect(entries.filter(e => e.kind === "reserve")).toHaveLength(1);
  expect(entries.filter(e => e.kind === "settle")).toHaveLength(1);
  expect(entries.filter(e => e.kind === "release")).toHaveLength(0);
  const stored = (await root.query<[Array<{ envelope: string }>]>("SELECT envelope FROM chat_delivery WHERE run_id = $run", { run: start.runId }))[0][0]!;
  expect(stored.envelope).not.toContain("AUTHORIZED_D1_RESULT");
  const session = await caller();
  const row = await store.read(session, start.runId);
  expect(() => store.decrypt(row, "another_workspace", "member")).toThrow();
  expect(() => store.decrypt(row, db, "other")).toThrow();
  subject = "other";
  expect((await restarted.post(`/api/chat/runs/${start.runId}/recover`)).status).toBe(403);
  subject = "member";
});

local("real persistence rejection and model failure release, with no success broadcast", async () => {
  await root.query(`DEFINE EVENT fixture_delivery_reject ON chat_delivery WHEN $after.status = "complete" THEN { THROW "fixture-persistence-failed"; };`);
  const h = makeApp(async i => ({ runId: i.runId, finalText: "must not be billed", status: "success" }));
  const response = await h.post("/api/chat", { message: "persistence failure", idempotencyKey: "persist-fail" });
  expect(response.status).toBe(200);
  const start = await response.json() as { runId: string };
  const events: ChatStreamEvent[] = []; h.bus.subscribe(start.runId, e => events.push(e));
  await until(async () => (await ledger(start.runId)).some(e => e.kind === "release"));
  expect(events.some(e => e.kind === "done")).toBe(false);
  expect((await ledger(start.runId)).some(e => e.kind === "settle")).toBe(false);
  await root.query("REMOVE EVENT fixture_delivery_reject ON chat_delivery;");
  const failed = makeApp(async () => { throw new Error("fixture-model-failure"); });
  const r = await failed.post("/api/chat", { message: "model failure", idempotencyKey: "model-fail" });
  const run = await r.json() as { runId: string };
  await until(async () => (await ledger(run.runId)).some(e => e.kind === "release"));
  expect((await ledger(run.runId)).filter(e => e.kind === "settle")).toHaveLength(0);
});

local("bounded execution releases reservation and suppresses late model completion", async () => {
  let finish!: () => void;
  const h = makeApp(async i => { await new Promise<void>(r => { finish = r; }); return { runId: i.runId, finalText: "late", status: "success" }; }, { maxRunMs: 20 });
  const r = await h.post("/api/chat", { message: "stuck model", idempotencyKey: "deadline" });
  const run = await r.json() as { runId: string };
  await until(async () => (await ledger(run.runId)).some(e => e.kind === "release"));
  finish(); await new Promise(r => setTimeout(r, 10));
  expect((await ledger(run.runId)).some(e => e.kind === "settle")).toBe(false);
  expect((await h.post(`/api/chat/runs/${run.runId}/recover`)).status).toBe(409);
});

local("execution window ends before settlement: slow persistence still settles once, never released then re-settled", async () => {
  // 执行窗（maxRunMs）只约束模型调用；收口落账慢于执行窗时不得被 deadline 抢跑成失败，
  // 否则会出现「release 之后行又落成 complete、恢复时再 settle」的账本错位。
  const h = makeApp(async i => {
    i.pushChunk({ streamId: i.streamId, type: "done", message: { id: "slow-persist", role: "assistant", content: "SLOW_PERSIST_RESULT", context, createdAt: new Date().toISOString() }, toolCalls: [] });
    return { runId: i.runId, finalText: "SLOW_PERSIST_RESULT", status: "success" };
  }, { maxRunMs: 20, saveDelayMs: 120, settleDelayMs: 120 });
  const r = await h.post("/api/chat", { message: "slow settle", idempotencyKey: "slow-settle" });
  expect(r.status).toBe(200);
  const run = await r.json() as { runId: string };
  await until(async () => (await ledger(run.runId)).some(e => e.kind === "settle"));
  const entries = await ledger(run.runId);
  expect(entries.filter(e => e.kind === "reserve")).toHaveLength(1);
  expect(entries.filter(e => e.kind === "settle")).toHaveLength(1);
  expect(entries.filter(e => e.kind === "release")).toHaveLength(0);
  const row = (await root.query<[Array<{ status: string }>]>("SELECT status FROM chat_delivery WHERE run_id = $run", { run: run.runId }))[0][0]!;
  expect(row.status).toBe("complete");
  const recovered = await h.post(`/api/chat/runs/${run.runId}/recover`);
  expect(recovered.status).toBe(200);
  expect((await recovered.json()).result.message.content).toBe("SLOW_PERSIST_RESULT");
  expect((await ledger(run.runId)).filter(e => e.kind === "settle")).toHaveLength(1);
});


local("platform evidence re-verification reads current facts: license/item/collection/body mutations block recovery without another charge", async () => {
  // 交付复核不再开 content_reader 会话（IdP 换票是同步 recover 的生产超时源）；
  // 改为读底层事实（版本/条款/集合/正文哈希）+ 当前权益快照，复用换票谓词重算门禁。
  const contentDb = `${db}_content`;
  await root.query(`DEFINE DATABASE ${contentDb};`);
  const contentRoot = new Surreal(); connections.push(contentRoot);
  await contentRoot.connect(url, { authentication: { username: "root", password: "root" }, namespace: "d1_test", database: contentDb });
  for (const script of await loadPlatformContentScripts()) await contentRoot.query(script.sql);
  await contentRoot.query(`
    CREATE content_source:s SET source_key='s', label='synthetic', base_url='https://example.invalid', status='active', allowed_actions=['publish'];
    CREATE source_license_revision:l SET source=content_source:s, revision=1, license_kind='synthetic', allowed_actions=['browse','search','read','cite','export','research','generate'], effective_from=time::now()-1h, created_by_subject='fixture';
    CREATE content_item:i SET public_id='i', kind='legislation', publication_status='published';
    CREATE content_version:v SET public_id='v', item=content_item:i, revision=1, source=content_source:s, source_url='https://example.invalid', fetched_at=time::now(), title='synthetic', body_text='synthetic body', body_sha256='fixture', source_form='full_text', evidence=[], field_issues=[], processing={}, content_kind_payload={}, created_by_subject='fixture';
    CREATE content_collection_binding:b SET item=content_item:i, collections=['core'];
  `);
  // _system 成员索引与权益快照用存根（夹具无 _system 库）；平台事实用真实 schema 库查询。
  const verifier = createDeliveryVerifierFactory({
    systemSession: async () => ({ query: async () => [[{ subject: "member", disabled_at: null, workspace: { id: "workspace:ws_test", status: "active" } }]] }),
    workspaceSession: async () => ({ query: async () => [[{ id: "user:member", disabled_at: null }]] }),
    contentSession: async () => contentRoot,
    currentSnapshot: async () => ({
      id: "workspace_product_entitlement:fixture", workspaceId: "workspace:ws_test", workspaceSlug: "ws_test",
      revision: 1, digest: "sha256:fixture", summary: "fixture", resolverVersion: "test",
      baseSourceKind: "subscription", baseSourceId: "fixture", productPlanRevisionId: null,
      productPlanKey: null, productPlanName: null, productRevisionNumber: null,
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(), effectiveUntil: null,
      collections: [{ key: "core", label: "core" }], actions: ["browse", "read", "cite"],
      sources: [], aiActions: ["research"], features: [], correlationId: "fixture",
    }),
    rolloutGates: async () => "enabled",
  });
  const h = makeApp(async i => {
    i.pushChunk({ streamId: i.streamId, type: "done", message: { id: "licensed", role: "assistant", content: "licensed result", context, createdAt: new Date().toISOString() }, toolCalls: [], deliveryProof: [{ authorization: { workspaceId: db, kind: "ready", revision: "1", digest: "sha256:fixture", leaseEndSeconds: Date.now()/1000+60 }, platform: [{ versionId: "content_version:v", bodySha256: "fixture", cite: true }], private: [] }] });
    return { runId: i.runId, finalText: "licensed result", status: "success" };
  }, { verifier });
  const r = await h.post("/api/chat", { message: "licensed research", idempotencyKey: "licensed" }); expect(r.status).toBe(200);
  const { runId } = await r.json() as { runId: string };
  await until(async () => (await ledger(runId)).some(e => e.kind === "settle"));
  expect((await h.post(`/api/chat/runs/${runId}/recover`)).status).toBe(200);
  // 许可修订与内容版本在引擎层不可变：撤权 = 更高 revision 行；正文哈希篡改只可能经单测桩覆盖。
  let licRev = 1;
  const ALL_ACTIONS = "'browse','search','read','cite','export','research','generate'";
  const license = (actions: string, until: string | null) =>
    `CREATE source_license_revision SET source=content_source:s, revision=${++licRev}, license_kind='synthetic', allowed_actions=[${actions}], effective_from=time::now()-1h, created_by_subject='fixture'${until === null ? "" : `, effective_until=${until}`};`;
  for (const [revoke, restore] of [
    [license(ALL_ACTIONS, "time::now()-1s"), license(ALL_ACTIONS, null)],            // 许可到期
    ["UPDATE content_item:i SET publication_status='withdrawn';", "UPDATE content_item:i SET publication_status='published';"],
    ["UPDATE content_source:s SET status='inactive';", "UPDATE content_source:s SET status='active';"],
    ["UPDATE content_collection_binding:b SET collections=['other'];", "UPDATE content_collection_binding:b SET collections=['core'];"],
    [license("'browse','search','read','cite','export'", null), license(ALL_ACTIONS, null)],   // AI 动作被吊销
    [license("'read','research'", null), license(ALL_ACTIONS, null)],                          // cite 证据但许可不再授引用
  ] as Array<[string, string]>) {
    await contentRoot.query(revoke);
    expect((await h.post(`/api/chat/runs/${runId}/recover`)).status).not.toBe(200);
    await expect(h.registry.get(runId)!.authorize!()).rejects.toThrow();
    await contentRoot.query(restore);
  }
  expect((await h.post(`/api/chat/runs/${runId}/recover`)).status).toBe(200);
  expect((await ledger(runId)).filter(e => e.kind === "settle")).toHaveLength(1);
  expect((await ledger(runId)).filter(e => e.kind === "reserve")).toHaveLength(1);
});

local("tampered encrypted result and disabled workspace member cannot recover", async () => {
  const h = makeApp(async i => ({ runId: i.runId, finalText: "private", status: "success" }));
  const r = await h.post("/api/chat", { message: "member test", idempotencyKey: "member-test" }); const { runId } = await r.json() as { runId: string };
  await until(async () => (await ledger(runId)).some(e => e.kind === "settle"));
  await root.query("UPDATE user:member SET disabled_at=time::now();");
  expect((await h.post(`/api/chat/runs/${runId}/recover`)).status).toBe(403);
  await root.query("UPDATE user:member SET disabled_at=NONE; UPDATE chat_delivery SET envelope=$bad WHERE run_id=$run;", { bad: JSON.stringify({v:1,iv:"bad",tag:"bad",data:"bad"}), run: runId });
  expect((await h.post(`/api/chat/runs/${runId}/recover`)).status).toBe(409);
  expect((await ledger(runId)).filter(e => e.kind === "settle")).toHaveLength(1);
  const session = await caller();
  await store.claim(session, { runId: "conflict-run", requestKey: "hash-conflict", requestHash: requestDigest("a") });
  await expect(store.claim(session, { runId: "new-run", requestKey: "hash-conflict", requestHash: requestDigest("b") })).rejects.toThrow("重试必须使用原始问题与上下文");
});


local("private evidence changes reject old answers; interrupted restart releases instead of rerunning", async () => {
  await root.query(`DEFINE FIELD evidence.* ON resource_item TYPE object FLEXIBLE;
    CREATE resource_item:d1 SET resource_type='generic_note', title='private', summary='private', evidence=[{text:'original quote'}], quality='user-confirmed', content_hash='c', evidence_hash='e', source_hash='s', created_by=user:member;`);
  const session = await caller();
  const proof = [{ authorization: { workspaceId: db, kind: "empty" as const }, platform: [], private: [{ resourceId: "resource_item:d1", quoteSha256: requestDigest("original quote") }] }];
  await authorizeDelivery(session, proof);
  await root.query("UPDATE resource_item:d1 SET evidence=[{text:'changed quote'}];");
  await expect(authorizeDelivery(session, proof)).rejects.toThrow("当前材料或授权已变化");
  const runId = "process-interrupted";
  await store.claim(session, { runId, requestKey: runId, requestHash: requestDigest(runId) });
  await allowance.reserve({ db, runId, actionKey: "research", channel: "interactive", actor: new StringRecordId("user:member"), idempotencyKey: runId });
  const h = makeApp(async () => { throw new Error("must not rerun"); });
  expect((await h.post(`/api/chat/runs/${runId}/recover`)).status).toBe(409);
  expect((await ledger(runId)).filter(e => e.kind === "release")).toHaveLength(1);
  expect((await ledger(runId)).filter(e => e.kind === "settle")).toHaveLength(0);
});
