import { describe, expect, test } from "bun:test";
import type { FollowUpItem, OpsProposal } from "@surreal-ck/shared";
import { OpsProposalService, type OpsProposalStore } from "./service";

const now = "2026-09-22T12:00:00.000Z";
const followUp: FollowUpItem = {
  followUpId: "activation_follow_up:one", workspaceSlug: "team", summaryId: "workspace_activation_summary:one",
  reason: "activation_incomplete", period: { startedAt: now, endedAt: now, timeZone: "UTC" },
  dedupeKey: "one", sourceContractVersion: "2", sourceUpdatedAt: now, sourceAvailable: true,
  sourceFreshness: "fresh", status: "open", ownerSubject: null, leaseExpiresAt: null,
  dueCheckAt: null, result: null, version: 1, createdAt: now, updatedAt: now, nextStep: "claim",
};
const capabilities = ["activation.proposal.read", "activation.proposal.submit", "activation.proposal.review", "activation.proposal.execute", "activation.followup.read", "activation.followup.write"];
const actor = { subject: "human", kind: "human" as const, capabilities };

class MemoryStore implements OpsProposalStore {
  item: OpsProposal | null = null;
  followUp = { ...followUp };
  summaryUpdatedAt: string | null = now;
  events: string[] = [];
  idempotency = new Map<string, { item: OpsProposal; requestDigest: string }>();
  appliedActionVersion: number | null = null;
  failFinishOnce = false;
  async getFollowUp() { return this.followUp; }
  async getSummaryUpdatedAt() { return this.summaryUpdatedAt; }
  async findByIdempotency(subject: string, key: string) { return this.idempotency.get(`${subject}:${key}`) ?? null; }
  async get() { return this.item; }
  async list() { return this.item ? [this.item] : []; }
  async create(input: Parameters<OpsProposalStore["create"]>[0]) {
    this.item = { proposalId: "ops_proposal:one", followUpId: input.followUpId, summaryId: input.summaryId,
      summaryUpdatedAt: input.summaryUpdatedAt, followUpVersion: input.followUpVersion,
      action: input.action, actionDigest: "", rationale: input.rationale, expectedResult: input.expectedResult,
      triggerReason: input.triggerReason, inputSummary: input.inputSummary, proposerSubject: input.actorSubject,
      agentId: input.agentId, status: "pending", version: 1, executorSubject: null, reviewerSubject: null, reviewReason: null,
      toolResult: null, actionFollowUpVersion: null, createdAt: now, updatedAt: now };
    this.events.push("submitted");
    this.idempotency.set(`${input.actorSubject}:${input.idempotencyKey}`, { item: this.item, requestDigest: input.requestDigest });
    return this.item;
  }
  async review(input: Parameters<OpsProposalStore["review"]>[0]) {
    if (!this.item || this.item.version !== input.expectedVersion || this.item.status !== "pending") return null;
    this.item = { ...this.item, status: input.decision === "approve" ? "approved" : "rejected", reviewerSubject: input.actorSubject, reviewReason: input.reason, version: 2 };
    this.events.push(input.decision);
    this.idempotency.set(`${input.actorSubject}:${input.idempotencyKey}`, { item: this.item, requestDigest: input.requestDigest });
    return this.item;
  }
  async reserve(input: Parameters<OpsProposalStore["reserve"]>[0]) {
    if (!this.item || this.item.status !== "approved" || this.item.version !== input.expectedVersion) return null;
    this.item = { ...this.item, status: "executing", executorSubject: input.actorSubject, version: this.item.version + 1 };
    this.events.push("execution_started");
    return this.item;
  }
  async finish(input: Parameters<OpsProposalStore["finish"]>[0]) {
    if (this.failFinishOnce) { this.failFinishOnce = false; throw new Error("proposal result write unavailable"); }
    if (!this.item || (this.item.status !== "approved" && this.item.status !== "executing")) return this.item;
    this.item = { ...this.item, status: input.status, toolResult: input.toolResult, actionFollowUpVersion: input.actionFollowUpVersion, version: 3 };
    this.events.push(input.status);
    this.idempotency.set(`${input.actorSubject}:${input.idempotencyKey}`, { item: this.item, requestDigest: input.requestDigest });
    return this.item;
  }
  async takeover(input: Parameters<OpsProposalStore["takeover"]>[0]) {
    if (this.followUp.version !== input.expectedVersion) return null;
    this.followUp = { ...this.followUp, ownerSubject: input.actorSubject, leaseExpiresAt: input.leaseExpiresAt, version: this.followUp.version + 1, status: "claimed" };
    this.events.push("taken_over");
    return this.followUp;
  }
  async findTakeoverIdempotency() { return null; }
  async findAppliedAction() { return this.appliedActionVersion ? { followUpVersion: this.appliedActionVersion } : null; }
}

const submit = { followUpId: followUp.followUpId, followUpVersion: 1, summaryUpdatedAt: now,
  action: { type: "follow_up.claim" as const, leaseSeconds: 900 }, rationale: "需要人工跟进启用问题",
  expectedResult: "运营人员获得内部事项认领", triggerReason: "fresh_activation_opportunity",
  inputSummary: "新鲜的启用摘要显示未完成", idempotencyKey: "proposal-submit-001" };

describe("ops proposal service", () => {
  test("审批前不执行；审批绑定版本和动作，重复审批冲突", async () => {
    const store = new MemoryStore();
    const claims: string[] = [];
    const service = new OpsProposalService(store, { claim: async (_actor, input) => { claims.push(input.followUpId); return { ...followUp, version: 2, status: "claimed" }; }, update: async () => followUp });
    const proposed = await service.submit(actor, submit);
    expect(claims).toHaveLength(0);
    await expect(service.review(actor, { proposalId: proposed.proposalId, expectedVersion: 1, actionDigest: service.actionDigest(proposed.action), decision: "approve", reason: "同意内部认领", idempotencyKey: "proposal-review-001" })).resolves.toMatchObject({ status: "approved" });
    expect(claims).toHaveLength(0);
    await expect(service.review(actor, { proposalId: proposed.proposalId, expectedVersion: 1, actionDigest: service.actionDigest(proposed.action), decision: "approve", reason: "再次审批", idempotencyKey: "proposal-review-002" })).rejects.toMatchObject({ code: "conflict" });
  });

  test("前提改变使旧批准失效；审批不扩展执行 capability", async () => {
    const store = new MemoryStore();
    const service = new OpsProposalService(store, { claim: async () => followUp, update: async () => followUp });
    const proposed = await service.submit(actor, submit);
    await service.review(actor, { proposalId: proposed.proposalId, expectedVersion: 1, actionDigest: service.actionDigest(proposed.action), decision: "approve", reason: "同意", idempotencyKey: "proposal-review-003" });
    await expect(service.execute({ subject: "human", capabilities: ["activation.proposal.execute"] }, { proposalId: proposed.proposalId, expectedVersion: 2, idempotencyKey: "proposal-execute-001" })).rejects.toMatchObject({ code: "capability_missing" });
    await expect(service.execute({ subject: "human", capabilities: ["activation.proposal.execute", "activation.proposal.read", "activation.followup.write"] }, { proposalId: proposed.proposalId, expectedVersion: 2, idempotencyKey: "proposal-execute-no-read" })).rejects.toMatchObject({ code: "capability_missing" });
    store.followUp.version = 2;
    await expect(service.execute(actor, { proposalId: proposed.proposalId, expectedVersion: 2, idempotencyKey: "proposal-execute-002" })).resolves.toMatchObject({ status: "stale", toolResult: { code: "premise_changed" } });
  });

  test("执行结果来自真实工具结果；失败与重复执行有记录", async () => {
    const store = new MemoryStore();
    let calls = 0;
    const service = new OpsProposalService(store, { claim: async () => { calls++; throw new Error("database unavailable"); }, update: async () => followUp });
    const proposed = await service.submit(actor, submit);
    await service.review(actor, { proposalId: proposed.proposalId, expectedVersion: 1, actionDigest: service.actionDigest(proposed.action), decision: "approve", reason: "同意", idempotencyKey: "proposal-review-004" });
    expect(await service.execute(actor, { proposalId: proposed.proposalId, expectedVersion: 2, idempotencyKey: "proposal-execute-003" })).toMatchObject({ status: "failed", toolResult: { code: "action_failed" } });
    expect(calls).toBe(1);
    await expect(service.execute(actor, { proposalId: proposed.proposalId, expectedVersion: 2, idempotencyKey: "proposal-execute-004" })).rejects.toMatchObject({ code: "conflict" });
  });

  test("人工接管覆盖旧租约并令旧建议版本失效", async () => {
    const store = new MemoryStore();
    store.followUp.ownerSubject = "agent";
    store.followUp.leaseExpiresAt = "2026-09-22T13:00:00.000Z";
    const service = new OpsProposalService(store, { claim: async () => followUp, update: async () => followUp });
    const proposed = await service.submit(actor, submit);
    const taken = await service.takeover({ ...actor, capabilities: [...capabilities, "activation.proposal.takeover"] }, { followUpId: followUp.followUpId, expectedVersion: 1, leaseSeconds: 900, reason: "人工接管", idempotencyKey: "takeover-0001" });
    expect(taken).toMatchObject({ ownerSubject: "human", version: 2 });
    await expect(service.review(actor, { proposalId: proposed.proposalId, expectedVersion: 1, actionDigest: service.actionDigest(proposed.action), decision: "approve", reason: "批准", idempotencyKey: "review-after-takeover" })).rejects.toMatchObject({ code: "conflict" });
  });

  test("agent 身份不能自审建议或接管", async () => {
    const store = new MemoryStore();
    const service = new OpsProposalService(store, { claim: async () => followUp, update: async () => followUp });
    const agent = { ...actor, kind: "agent" as const, agentId: "agent-runtime-1", capabilities: [...capabilities, "activation.proposal.takeover"] };
    const proposed = await service.submit(agent, submit);
    await expect(service.review(agent, { proposalId: proposed.proposalId, expectedVersion: 1, actionDigest: service.actionDigest(proposed.action), decision: "approve", reason: "自审", idempotencyKey: "agent-self-review" })).rejects.toMatchObject({ code: "capability_missing" });
    await expect(service.review({ subject: "another", capabilities }, { proposalId: proposed.proposalId, expectedVersion: 1, actionDigest: service.actionDigest(proposed.action), decision: "approve", reason: "未知身份", idempotencyKey: "unknown-kind-review" })).rejects.toMatchObject({ code: "capability_missing" });
    await expect(service.takeover(agent, { followUpId: followUp.followUpId, expectedVersion: 1, leaseSeconds: 900, reason: "自接管", idempotencyKey: "agent-self-takeover" })).rejects.toMatchObject({ code: "capability_missing" });
  });

  test("不同执行人竞争时仅保留一个执行权，已落库动作可恢复结果", async () => {
    const store = new MemoryStore();
    let calls = 0;
    const service = new OpsProposalService(store, { claim: async () => { calls++; store.appliedActionVersion = 2; return { ...followUp, version: 2, status: "claimed" }; }, update: async () => followUp });
    const proposed = await service.submit(actor, submit);
    const approved = await service.review(actor, { proposalId: proposed.proposalId, expectedVersion: 1, actionDigest: service.actionDigest(proposed.action), decision: "approve", reason: "同意", idempotencyKey: "proposal-review-race" });
    store.failFinishOnce = true;
    const first = await Promise.allSettled([
      service.execute(actor, { proposalId: proposed.proposalId, expectedVersion: approved.version, idempotencyKey: "proposal-execute-race-a" }),
      service.execute({ ...actor, subject: "other-human" }, { proposalId: proposed.proposalId, expectedVersion: approved.version, idempotencyKey: "proposal-execute-race-b" }),
    ]);
    expect(first.filter((row) => row.status === "rejected")).toHaveLength(2);
    expect(calls).toBe(1);
    expect(store.item).toMatchObject({ status: "executing", executorSubject: "human" });
    await expect(service.execute({ ...actor, subject: "other-human" }, { proposalId: proposed.proposalId, expectedVersion: 3, idempotencyKey: "proposal-execute-race-b2" })).rejects.toMatchObject({ code: "conflict" });
    const resumed = await service.execute(actor, { proposalId: proposed.proposalId, expectedVersion: 3, idempotencyKey: "proposal-execute-race-a" });
    expect(resumed).toMatchObject({ status: "succeeded", toolResult: { code: "action_succeeded", followUpVersion: 2 } });
    expect(calls).toBe(1);
  });
});
