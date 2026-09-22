import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { StringRecordId, Surreal } from "surrealdb";
import { ensureSystemSchema } from "../db/system-schema";
import { OpsFollowUpService } from "./service";
import { SurrealOpsFollowUpStore } from "./store";

const enabled = process.env.RUN_LOCAL_SURREALDB_FOLLOW_UP_TESTS === "1";
const localTest = test.skipIf(!enabled);
let endpoint = "";
let processHandle: ReturnType<typeof Bun.spawn> | null = null;
const sessions: Surreal[] = [];

async function freePort(): Promise<number> {
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
  const port = await freePort();
  endpoint = `ws://127.0.0.1:${port}`;
  processHandle = Bun.spawn(["surreal", "start", "--no-banner", "--log", "none", "--bind", `127.0.0.1:${port}`, "--user", "root", "--pass", "root", "memory"], { stdout: "ignore", stderr: "ignore" });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ready = Bun.spawn(["surreal", "is-ready", "--endpoint", endpoint], { stdout: "ignore", stderr: "ignore" });
    if (await ready.exited === 0) break;
    await Bun.sleep(100);
  }
  const root = await session("_system");
  await ensureSystemSchema(root, { namespace: "main" });
  await root.query(`
    CREATE workspace:demo SET db_name = "ws_demo", owner_subject = "admin", slug = "demo", name = "Demo", status = "active";
    CREATE workspace_activation_summary:demo SET
      workspace = workspace:demo, workspace_slug = "demo", contract_version = "2", dedupe_key = "period-v2",
      status = "active", supplied_by_subject = "admin", supplied_at = d'2026-09-22T11:00:00Z',
      content = {
        contractVersion: "2", period: { startedAt: "2026-09-01T00:00:00.000Z", endedAt: "2026-10-01T00:00:00.000Z", timeZone: "UTC" },
        stage: "incomplete",
        progress: {}, outcomes: {}, updatedAt: "2026-09-22T11:00:00.000Z", dedupeKey: "period-v2"
      };
  `).collect();
});

afterAll(async () => {
  await Promise.all(sessions.map(async (db) => { await db.close(); }));
  processHandle?.kill();
  if (processHandle) await processHandle.exited;
});

describe("ops follow-up Surreal store", () => {
  localTest("deduplicates, fences concurrent claims, allows expiry takeover and hides withdrawn source", async () => {
    const root = sessions[0]!;
    const store = new SurrealOpsFollowUpStore(async (database) => await session(database), "main");
    let now = new Date(Date.now() + 1_000);
    const service = new OpsFollowUpService(store, () => now);
    const reader = { subject: "ops-reader", capabilities: ["activation.followup.read"] };
    const writer = { subject: "ops-a", capabilities: ["activation.followup.read", "activation.followup.write"] };
    const opportunity = (await service.listOpportunities(reader, {})).items[0]!;
    const first = await service.create(writer, { opportunityId: opportunity.opportunityId, dueCheckAt: null, idempotencyKey: "create-real-0001" });
    const replay = await service.create(writer, { opportunityId: opportunity.opportunityId, dueCheckAt: null, idempotencyKey: "create-real-0001" });
    expect(replay.followUpId).toBe(first.followUpId);
    await expect(service.create(writer, { opportunityId: opportunity.opportunityId, dueCheckAt: "2026-09-25T00:00:00.000Z", idempotencyKey: "create-real-0001" })).rejects.toMatchObject({ code: "conflict" });
    const duplicate = await service.create(writer, { opportunityId: opportunity.opportunityId, dueCheckAt: null, idempotencyKey: "create-real-0002" });
    expect(duplicate.followUpId).toBe(first.followUpId);

    const claims = await Promise.allSettled([
      service.claim(writer, { followUpId: first.followUpId, expectedVersion: 1, leaseSeconds: 60, idempotencyKey: "claim-real-a-0001" }),
      service.claim({ ...writer, subject: "ops-b" }, { followUpId: first.followUpId, expectedVersion: 1, leaseSeconds: 60, idempotencyKey: "claim-real-b-0001" }),
    ]);
    expect(claims.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const claimed = claims.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.claim>>> => result.status === "fulfilled")!.value;
    now = new Date(now.getTime() + 120_000);
    const later = new OpsFollowUpService(new SurrealOpsFollowUpStore(async (database) => await session(database), "main"), () => now);
    const reclaimed = await later.claim({ ...writer, subject: "ops-c" }, { followUpId: first.followUpId, expectedVersion: claimed.version, leaseSeconds: 60, idempotencyKey: "claim-real-c-0001" });
    expect(reclaimed.ownerSubject).toBe("ops-c");
    await expect(later.update({ ...writer, subject: claimed.ownerSubject! }, { followUpId: first.followUpId, expectedVersion: reclaimed.version, status: "resolved", dueCheckAt: null, result: "stale", idempotencyKey: "update-old-real-0001" })).rejects.toMatchObject({ code: "conflict" });

    await root.query(`UPDATE workspace_activation_summary:demo SET status = "withdrawn", content = NONE, supplied_by_subject = NONE, supplied_at = NONE;`).collect();
    const queued = await later.listFollowUps(reader, {});
    expect(queued.items[0]).toMatchObject({ sourceAvailable: false, summaryId: "workspace_activation_summary:demo", reason: "activation_incomplete" });
    expect(await later.listOpportunities(reader, {})).toEqual({ items: [], nextCursor: null });
    await expect(store.create({ actorSubject: "ops-a", idempotencyKey: "stale-create-0001", requestDigest: "stale", workspaceSlug: opportunity.workspaceSlug, summaryId: opportunity.summaryId, reason: opportunity.reason, period: opportunity.period, dedupeKey: `${first.dedupeKey}|stale`, sourceContractVersion: opportunity.sourceContractVersion, sourceUpdatedAt: opportunity.sourceUpdatedAt, dueCheckAt: null })).rejects.toThrow();
    expect(await store.findIdempotent("ops-a", "stale-create-0001")).toBeNull();
    const audits = await root.query(`SELECT * FROM activation_follow_up_audit WHERE follow_up = $followUp ORDER BY occurred_at;`, { followUp: new StringRecordId(first.followUpId) }).collect();
    expect(audits[0]).toHaveLength(4);
  }, 30_000);
});
