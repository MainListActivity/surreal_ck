import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { Surreal } from "surrealdb";
import { ensureSystemSchema } from "../db/system-schema";
import { ActivationSummaryService } from "./service";
import { SurrealActivationSummaryStore } from "./store";

const enabled = process.env.RUN_LOCAL_SURREALDB_ACTIVATION_SUMMARY_TESTS === "1";
const localTest = test.skipIf(!enabled);
let endpoint = "";
let processHandle: ReturnType<typeof Bun.spawn> | null = null;
const sessions: Surreal[] = [];

async function port(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("port unavailable"));
      server.close(() => resolve(address.port));
    });
  });
}

async function session(database: string): Promise<Surreal> {
  const db = new Surreal();
  await db.connect(`${endpoint}/rpc`);
  await db.signin({ username: "root", password: "root" });
  await db.use({ namespace: "main", database });
  sessions.push(db);
  return db;
}

beforeAll(async () => {
  if (!enabled) return;
  const selectedPort = await port();
  endpoint = `ws://127.0.0.1:${selectedPort}`;
  processHandle = Bun.spawn([
    "surreal", "start", "--no-banner", "--log", "none", "--bind", `127.0.0.1:${selectedPort}`,
    "--user", "root", "--pass", "root", "memory",
  ], { stdout: "ignore", stderr: "ignore" });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ready = Bun.spawn(["surreal", "is-ready", "--endpoint", endpoint], { stdout: "ignore", stderr: "ignore" });
    if (await ready.exited === 0) break;
    await Bun.sleep(100);
  }
  const root = await session("_system");
  await ensureSystemSchema(root, { namespace: "main" });
  await root.query(`
    CREATE workspace:demo SET db_name = "ws_demo", owner_subject = "admin-1", slug = "demo", name = "Demo", status = "active";
    CREATE user_workspace_index:admin SET subject = "admin-1", workspace = workspace:demo, db_name = "ws_demo", role = "admin";
    CREATE workspace:demo2 SET db_name = "ws_demo2", owner_subject = "admin-2", slug = "demo-2", name = "Demo 2", status = "active";
    CREATE user_workspace_index:admin2 SET subject = "admin-2", workspace = workspace:demo2, db_name = "ws_demo2", role = "admin";
  `).collect();
  const workspace = await session("ws_demo");
  await workspace.query(`
    DEFINE TABLE user SCHEMAFULL;
    DEFINE FIELD subject ON TABLE user TYPE option<string>;
    DEFINE FIELD kind ON TABLE user TYPE string;
    DEFINE FIELD is_admin ON TABLE user TYPE bool;
    DEFINE FIELD disabled_at ON TABLE user TYPE option<datetime>;
    CREATE user:admin SET subject = "admin-1", kind = "human", is_admin = true;
  `).collect();
  const workspace2 = await session("ws_demo2");
  await workspace2.query(`
    DEFINE TABLE user SCHEMAFULL;
    DEFINE FIELD subject ON TABLE user TYPE option<string>;
    DEFINE FIELD kind ON TABLE user TYPE string;
    DEFINE FIELD is_admin ON TABLE user TYPE bool;
    DEFINE FIELD disabled_at ON TABLE user TYPE option<datetime>;
    CREATE user:admin SET subject = "admin-2", kind = "human", is_admin = true;
  `).collect();
});

afterAll(async () => {
  await Promise.all(sessions.map(async (db) => { await db.close(); }));
  processHandle?.kill();
  if (processHandle) await processHandle.exited;
});

describe("activation summary Surreal store", () => {
  localTest("persists, pages, replays and clears team-supplied content", async () => {
    const store = new SurrealActivationSummaryStore(async (database) => await session(database), "main");
    const service = new ActivationSummaryService(store);
    const summary = {
      contractVersion: "1" as const,
      period: { startedAt: "2026-09-01T00:00:00.000Z", endedAt: "2026-10-01T00:00:00.000Z", timeZone: "UTC" },
      stage: "incomplete" as const,
      metrics: {
        members: { state: "completed" as const, count: 1, source: "workspace.user" },
        workbooks: { state: "incomplete" as const, count: 0, source: "workspace.workbook" },
        imports: { state: "unknown" as const, count: null, source: "not_reported_v1" },
        reviews: { state: "unknown" as const, count: null, source: "not_reported_v1" },
      },
      updatedAt: "2026-09-22T12:00:00.000Z",
      dedupeKey: "2026-09:v1",
    };
    const first = await service.share({ workspaceSlug: "demo", actorSubject: "admin-1", summary, idempotencyKey: "request-0001" });
    const replay = await service.share({ workspaceSlug: "demo", actorSubject: "admin-1", summary, idempotencyKey: "request-0001" });
    expect(replay.summaryId).toBe(first.summaryId);
    await service.share({ workspaceSlug: "demo-2", actorSubject: "admin-2", summary, idempotencyKey: "request-0002" });
    const page = await service.list({ subject: "ops", capabilities: ["activation.summary.read"] }, { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeTypeOf("string");
    const secondPage = await service.list(
      { subject: "ops", capabilities: ["activation.summary.read"] },
      { limit: 1, cursor: page.nextCursor ?? undefined },
    );
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.summaryId).not.toBe(page.items[0]?.summaryId);
    const withdrawn = await service.withdraw({ workspaceSlug: "demo", actorSubject: "admin-1", idempotencyKey: "withdraw-0001" });
    expect(withdrawn).toMatchObject({ status: "withdrawn", summary: null });
    const remaining = await service.list({ subject: "ops", capabilities: ["activation.summary.read"] }, {});
    expect(remaining.items.map((item) => item.workspaceSlug)).toEqual(["demo-2"]);
  }, 30_000);
});
