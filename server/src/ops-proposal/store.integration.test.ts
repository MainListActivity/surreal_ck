import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { Surreal } from "surrealdb";
import { ensureSystemSchema } from "../db/system-schema";
import { OpsFollowUpService } from "../ops-follow-up/service";
import { SurrealOpsFollowUpStore } from "../ops-follow-up/store";
import { OpsProposalService } from "./service";
import { SurrealOpsProposalStore } from "./store";

const enabled = process.env.RUN_LOCAL_SURREALDB_PROPOSAL_TESTS === "1";
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
  await root.query(`CREATE workspace:demo SET db_name = "ws_demo", owner_subject = "admin", slug = "demo", name = "Demo", status = "active";
    CREATE workspace_activation_summary:demo SET workspace = workspace:demo, workspace_slug = "demo", contract_version = "2", dedupe_key = "proposal-period",
    status = "active", supplied_by_subject = "admin", supplied_at = time::now(),
    content = { contractVersion: "2", period: { startedAt: "2026-09-01T00:00:00.000Z", endedAt: "2026-10-01T00:00:00.000Z", timeZone: "UTC" },
    stage: "incomplete", progress: {}, outcomes: {}, updatedAt: "2026-09-22T12:00:00.000Z", dedupeKey: "proposal-period" };`).collect();
});
afterAll(async () => {
  await Promise.all(sessions.map((db) => db.close()));
  processHandle?.kill();
  if (processHandle) await processHandle.exited;
});

describe("ops proposal Surreal store", () => {
  localTest("审阅、真实动作结果、审计与人工接管遵循版本前提", async () => {
    const root = sessions[0]!;
    const followUpService = new OpsFollowUpService(new SurrealOpsFollowUpStore(async (database) => await session(database), "main"));
    const proposalService = new OpsProposalService(new SurrealOpsProposalStore(async (database) => await session(database), "main"), followUpService);
    const actor = { subject: "ops-human", kind: "human" as const, capabilities: ["activation.followup.read", "activation.followup.write", "activation.proposal.read", "activation.proposal.submit", "activation.proposal.review", "activation.proposal.execute", "activation.proposal.takeover"] };
    const opportunity = (await followUpService.listOpportunities(actor, {})).items[0]!;
    const item = await followUpService.create(actor, { opportunityId: opportunity.opportunityId, dueCheckAt: null, idempotencyKey: "proposal-real-followup-001" });
    const submitted = await proposalService.submit(actor, { followUpId: item.followUpId, followUpVersion: item.version, summaryUpdatedAt: item.sourceUpdatedAt,
      action: { type: "follow_up.claim", leaseSeconds: 900 }, rationale: "新鲜摘要有未完成事项", expectedResult: "人工认领内部事项",
      triggerReason: "fresh_activation_opportunity", inputSummary: "团队启用未完成", idempotencyKey: "proposal-real-submit-001" });
    expect(submitted.status).toBe("pending");
    const scopedStore = new SurrealOpsProposalStore(async (database) => await session(database), "main");
    expect((await scopedStore.list({ limit: 10, cursor: null, workspaceSlugs: ["demo"] })).map((row) => row.proposalId)).toContain(submitted.proposalId);
    expect(await scopedStore.list({ limit: 10, cursor: null, workspaceSlugs: ["other"] })).toEqual([]);
    expect(submitted.actionDigest).toBe(proposalService.actionDigest(submitted.action));
    const replay = await proposalService.submit(actor, { followUpId: item.followUpId, followUpVersion: item.version, summaryUpdatedAt: item.sourceUpdatedAt,
      action: { type: "follow_up.claim", leaseSeconds: 900 }, rationale: "新鲜摘要有未完成事项", expectedResult: "人工认领内部事项",
      triggerReason: "fresh_activation_opportunity", inputSummary: "团队启用未完成", idempotencyKey: "proposal-real-submit-001" });
    expect(replay.proposalId).toBe(submitted.proposalId);
    expect((await followUpService.listFollowUps(actor, {})).items[0]?.status).toBe("open");
    const approved = await proposalService.review(actor, { proposalId: submitted.proposalId, expectedVersion: submitted.version, actionDigest: submitted.actionDigest, decision: "approve", reason: "同意内部认领", idempotencyKey: "proposal-real-review-001" });
    expect(approved.status).toBe("approved");
    const executed = await proposalService.execute(actor, { proposalId: approved.proposalId, expectedVersion: approved.version, idempotencyKey: "proposal-real-execute-001" });
    expect(executed).toMatchObject({ status: "succeeded", toolResult: { code: "action_succeeded" }, actionFollowUpVersion: 2 });
    const taken = await proposalService.takeover({ ...actor, subject: "ops-other" }, { followUpId: item.followUpId, expectedVersion: 2, leaseSeconds: 900, reason: "交由另一位真人处理", idempotencyKey: "proposal-real-takeover-001" });
    expect(taken).toMatchObject({ ownerSubject: "ops-other", version: 3 });
    const audits = await root.query("SELECT event, occurred_at FROM ops_proposal_audit ORDER BY occurred_at;").collect();
    expect(audits[0]).toHaveLength(4);
    const storedKey = await root.query("SELECT VALUE idempotency_key FROM ops_proposal_audit LIMIT 1;").collect();
    expect(String(storedKey[0]?.[0])).toMatch(/^[a-f0-9]{64}$/u);

    const other = { ...actor, subject: "ops-other" };
    const followUpAfterTakeover = (await followUpService.listFollowUps(other, {})).items[0]!;
    const second = await proposalService.submit(other, { followUpId: item.followUpId, followUpVersion: followUpAfterTakeover.version,
      summaryUpdatedAt: followUpAfterTakeover.sourceUpdatedAt, action: { type: "follow_up.update", status: "waiting", dueCheckAt: null, result: null },
      rationale: "需要复查", expectedResult: "内部事项进入待检查", triggerReason: "manual_support_review",
      inputSummary: "内部状态更新", idempotencyKey: "proposal-real-submit-002" });
    const secondApproved = await proposalService.review(actor, { proposalId: second.proposalId, expectedVersion: second.version,
      actionDigest: second.actionDigest, decision: "approve", reason: "同意更新", idempotencyKey: "proposal-real-review-002" });
    const race = await Promise.allSettled([
      proposalService.execute(other, { proposalId: secondApproved.proposalId, expectedVersion: secondApproved.version, idempotencyKey: "proposal-real-execute-002" }),
      proposalService.takeover({ ...actor, subject: "ops-third" }, { followUpId: item.followUpId, expectedVersion: 3, leaseSeconds: 900, reason: "人工改派", idempotencyKey: "proposal-real-takeover-002" }),
    ]);
    const current = (await followUpService.listFollowUps(actor, {})).items[0]!;
    expect(current.version).toBe(4);
    const execution = race[0];
    if (execution.status === "fulfilled") {
      if (current.ownerSubject === "ops-other") expect(execution.value.status).toBe("succeeded");
      else expect(execution.value.status).toBe("stale");
    }
  }, 30_000);
});
