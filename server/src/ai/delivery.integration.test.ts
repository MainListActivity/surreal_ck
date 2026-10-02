import { beforeAll, afterAll, test, expect } from "bun:test";
import { Hono } from "hono";
import { Surreal } from "surrealdb";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { createDefaultAiContextSnapshot, type ChatStreamEvent } from "@surreal-ck/shared";
import { ChatDeliveryStore } from "./delivery-store";
import { createRunBus } from "./run-bus";
import { createRunRegistry } from "./run-registry";
import { createAiChatService, type ChatRunner } from "./chat-service";
import { createAiChatRoutes } from "../routes/ai-chat";
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
function makeApp(runner: ChatRunner, opts: { registry?: ReturnType<typeof createRunRegistry>; maxRunMs?: number } = {}) {
  const bus = createRunBus();
  const registry = opts.registry ?? createRunRegistry();
  const service = createAiChatService({ runBus: bus, runner, maxRunMs: opts.maxRunMs });
  const app = new Hono<AppBindings>().onError((error, c) => { return c.json({ code: error instanceof HttpError ? error.code : "internal" }, error instanceof HttpError ? error.status : 500); });
  app.route("/", createAiChatRoutes({ service, registry, deliveries: store, allowance,
    createCallerSession: caller,
    requireUser: () => async (c, next) => {
      c.set("user", { subject, rawToken: "local-fixture-token", raw: { db } } as AppBindings["Variables"]["user"]);
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
    ? [[{ ai_actions: ["research"], base_kind: "subscription", base_id: "fixture" }]] : [[{ db_name: db }]] };
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
