import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { Surreal } from "surrealdb";
import { ensureSystemSchema } from "../db/system-schema";
import { OpsFollowUpService } from "../ops-follow-up/service";
import { SurrealOpsFollowUpStore } from "../ops-follow-up/store";
import { OpsAutonomyService } from "./service";
import { SurrealOpsAutonomyStore } from "./store";

const enabled = process.env.RUN_LOCAL_SURREALDB_AUTONOMY_TESTS === "1";
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
  for (let attempt = 0; attempt < 50; attempt++) {
    const ready = Bun.spawn(["surreal", "is-ready", "--endpoint", endpoint], { stdout: "ignore", stderr: "ignore" });
    if (await ready.exited === 0) break;
    await Bun.sleep(100);
  }
  const root = await session("_system");
  await ensureSystemSchema(root, { namespace: "main" });
  await root.query(`CREATE platform_operator:agent SET subject = "agent-ops", kind = "agent", status = "active";
    CREATE platform_operator_capability:agent_read SET operator = platform_operator:agent, capability = "activation.followup.read", status = "active", granted_by_subject = "admin";
    CREATE platform_operator_capability:agent_write SET operator = platform_operator:agent, capability = "activation.followup.write", status = "active", granted_by_subject = "admin";
    CREATE workspace:demo SET db_name = "ws_demo", owner_subject = "admin", slug = "team-a", name = "Demo", status = "active";
    CREATE workspace_activation_summary:demo SET workspace = workspace:demo, workspace_slug = "team-a", contract_version = "2", dedupe_key = "autonomy-period",
      status = "active", supplied_by_subject = "admin", supplied_at = time::now(),
      content = { contractVersion: "2", period: { startedAt: "2026-09-01T00:00:00.000Z", endedAt: "2026-10-01T00:00:00.000Z", timeZone: "UTC" },
        stage: "incomplete", progress: {}, outcomes: {}, updatedAt: "2026-09-22T12:00:00.000Z", dedupeKey: "autonomy-period" };
    CREATE workspace:other SET db_name = "ws_other", owner_subject = "admin", slug = "team-b", name = "Other", status = "active";
    CREATE workspace_activation_summary:other SET workspace = workspace:other, workspace_slug = "team-b", contract_version = "2", dedupe_key = "autonomy-other",
      status = "active", supplied_by_subject = "admin", supplied_at = time::now(),
      content = { contractVersion: "2", period: { startedAt: "2026-09-01T00:00:00.000Z", endedAt: "2026-10-01T00:00:00.000Z", timeZone: "UTC" },
        stage: "incomplete", progress: {}, outcomes: {}, updatedAt: "2026-09-22T12:00:00.000Z", dedupeKey: "autonomy-other" };`).collect();
});
afterAll(async () => {
  await Promise.all(sessions.map((db) => db.close()));
  processHandle?.kill();
  if (processHandle) await processHandle.exited;
});

describe("ops autonomy Surreal store", () => {
  localTest("实时暂停、scope 收窄、恢复与撤权控制同一跟进动作", async () => {
    const root = sessions[0]!;
    const store = new SurrealOpsAutonomyStore(async (database) => await session(database), "main");
    const autonomy = new OpsAutonomyService(store);
    const followUps = new OpsFollowUpService(new SurrealOpsFollowUpStore(async (database) => await session(database), "main"), undefined, autonomy);
    const manager = { subject: "ops-human", kind: "human" as const, capabilities: ["activation.autonomy.read", "activation.autonomy.manage", "activation.followup.read", "activation.followup.write"] };
    const agent = { subject: "agent-ops", kind: "agent" as const, capabilities: ["activation.followup.read", "activation.followup.write"] };
    const policy = await autonomy.configure(manager, { agentSubject: "agent-ops", workspaceSlug: "team-a", actions: ["opportunity.read", "follow_up.create", "follow_up.read"], expectedVersion: null, idempotencyKey: "autonomy-create-001" });
    expect(policy).toMatchObject({ status: "active", version: 1, workspaceSlug: "team-a" });
    const opportunity = (await followUps.listOpportunities(agent, {})).items[0]!;
    expect(opportunity.workspaceSlug).toBe("team-a");
    expect((await followUps.listOpportunities(agent, {})).items).toHaveLength(1);
    const [pauseResult, inFlight] = await Promise.allSettled([
      autonomy.changeStatus(manager, { policyId: policy.policyId, expectedVersion: 1, status: "paused", reason: "人工暂停", idempotencyKey: "autonomy-pause-001" }),
      followUps.create(agent, { opportunityId: opportunity.opportunityId, dueCheckAt: null, idempotencyKey: "autonomy-inflight-001" }),
    ]);
    expect(pauseResult.status).toBe("fulfilled");
    const paused = (pauseResult as PromiseFulfilledResult<Awaited<ReturnType<typeof autonomy.changeStatus>>>).value;
    if (inFlight.status === "fulfilled") expect(inFlight.value.followUpId).toStartWith("activation_follow_up:");
    else expect(inFlight.reason).toMatchObject({ code: "paused" });
    await expect(followUps.create(agent, { opportunityId: opportunity.opportunityId, dueCheckAt: null, idempotencyKey: "autonomy-followup-001" })).rejects.toMatchObject({ code: "paused" });
    const resumed = await autonomy.changeStatus(manager, { policyId: policy.policyId, expectedVersion: paused.version, status: "active", reason: "恢复", idempotencyKey: "autonomy-resume-001" });
    await expect(followUps.create({ ...agent, capabilities: ["activation.followup.read"] }, { opportunityId: opportunity.opportunityId, dueCheckAt: null, idempotencyKey: "autonomy-followup-001" })).rejects.toMatchObject({ code: "capability_missing" });
    const created = await followUps.create(agent, { opportunityId: opportunity.opportunityId, dueCheckAt: null, idempotencyKey: "autonomy-followup-001" });
    expect(created.followUpId).toStartWith("activation_follow_up:");
    expect((await followUps.listFollowUps(agent, {})).items.map((row) => row.followUpId)).toContain(created.followUpId);
    const otherOpportunity = (await followUps.listOpportunities(manager, {})).items.find((row) => row.workspaceSlug === "team-b")!;
    await followUps.create(manager, { opportunityId: otherOpportunity.opportunityId, dueCheckAt: null, idempotencyKey: "autonomy-human-other-001" });
    expect((await followUps.listFollowUps(agent, {})).items.every((row) => row.workspaceSlug === "team-a")).toBe(true);
    const replay = await followUps.create(agent, { opportunityId: opportunity.opportunityId, dueCheckAt: null, idempotencyKey: "autonomy-followup-001" });
    expect(replay.followUpId).toBe(created.followUpId);
    await autonomy.changeStatus(manager, { policyId: policy.policyId, expectedVersion: resumed.version, status: "revoked", reason: "撤权", idempotencyKey: "autonomy-revoke-001" });
    await expect(followUps.listOpportunities(agent, {})).rejects.toMatchObject({ code: "revoked" });
    const audits = await root.query("SELECT * FROM ops_agent_policy_audit ORDER BY occurred_at;").collect();
    expect(audits[0]).toHaveLength(4);
  }, 30_000);
});
