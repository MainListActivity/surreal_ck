import { describe, expect, test } from "bun:test";
import type { OpsAutonomyAction, OpsAutonomyAudit, OpsAutonomyPolicy } from "@surreal-ck/shared";
import { OpsAutonomyService, type OpsAutonomyStore } from "./service";

const capabilities = ["activation.autonomy.read", "activation.autonomy.manage", "activation.followup.read", "activation.followup.write", "activation.proposal.read", "activation.proposal.submit", "activation.proposal.execute"];
const manager = { subject: "human", kind: "human" as const, capabilities };
const agent = { subject: "agent", kind: "agent" as const, capabilities };
const now = "2026-09-22T12:00:00.000Z";
class MemoryStore implements OpsAutonomyStore {
  policies: OpsAutonomyPolicy[] = [];
  audits: OpsAutonomyAudit[] = [];
  targetCapabilities = [...capabilities];
  async getOperatorKind(subject: string) { return subject === "agent" ? "agent" as const : null; }
  async getOperatorCapabilities() { return this.targetCapabilities; }
  async workspaceExists(slug: string) { return slug === "team-a"; }
  async listPolicies() { return this.policies; }
  async listAudit() { return this.audits; }
  async getPolicy(subject: string, workspaceSlug: string) { return this.policies.find((row) => row.agentSubject === subject && row.workspaceSlug === workspaceSlug) ?? null; }
  async getById(policyId: string) { return this.policies.find((row) => row.policyId === policyId) ?? null; }
  async findIdempotent() { return null; }
  async save(input: Parameters<OpsAutonomyStore["save"]>[0]) {
    const old = await this.getPolicy(input.agentSubject, input.workspaceSlug);
    if ((old?.version ?? null) !== input.expectedVersion) return null;
    const item: OpsAutonomyPolicy = { policyId: old?.policyId ?? `ops_agent_policy:${this.policies.length + 1}`, agentSubject: input.agentSubject, workspaceSlug: input.workspaceSlug,
      actions: input.actions, status: input.status, version: (old?.version ?? 0) + 1, updatedBySubject: input.actorSubject, updatedAt: now };
    if (old) this.policies.splice(this.policies.indexOf(old), 1, item); else this.policies.push(item);
    this.audits.push({ auditId: `ops_agent_policy_audit:${this.audits.length + 1}`, policyId: item.policyId, event: input.event,
      actorSubject: input.actorSubject, reason: input.reason, version: item.version, occurredAt: now });
    return item;
  }
}

describe("ops autonomy service", () => {
  test("工作区与动作取实时 capability、scope 和策略交集", async () => {
    const store = new MemoryStore();
    const service = new OpsAutonomyService(store);
    await expect(service.configure({ ...manager, capabilities: ["activation.autonomy.read", "activation.autonomy.manage"] }, {
      agentSubject: "agent", workspaceSlug: "team-a", actions: ["follow_up.create"], expectedVersion: null, idempotencyKey: "grant-denied-0001",
    })).rejects.toMatchObject({ code: "capability_missing" });
    const policy = await service.configure(manager, { agentSubject: "agent", workspaceSlug: "team-a", actions: ["follow_up.create", "follow_up.read"], expectedVersion: null, idempotencyKey: "grant-allowed-0001" });
    expect(policy.actions).toEqual(["follow_up.create", "follow_up.read"]);
    await expect(service.authorize(agent, "follow_up.create", "team-a")).resolves.toBeUndefined();
    await expect(service.authorize(agent, "follow_up.create", "team-b")).rejects.toMatchObject({ code: "out_of_scope" });
    await expect(service.authorize({ ...agent, capabilities: ["activation.followup.read"] }, "follow_up.create", "team-a")).rejects.toMatchObject({ code: "capability_missing" });
    expect(await service.allowedWorkspaces(agent, "follow_up.read")).toEqual(["team-a"]);
  });

  test("暂停、撤权和恢复实时生效，不清除原策略历史", async () => {
    const store = new MemoryStore();
    const service = new OpsAutonomyService(store);
    const first = await service.configure(manager, { agentSubject: "agent", workspaceSlug: "team-a", actions: ["follow_up.create"], expectedVersion: null, idempotencyKey: "grant-allowed-0002" });
    const paused = await service.changeStatus(manager, { policyId: first.policyId, expectedVersion: 1, status: "paused", reason: "人工暂停", idempotencyKey: "pause-0001" });
    expect(paused.version).toBe(2);
    await expect(service.configure(manager, { agentSubject: "agent", workspaceSlug: "team-a", actions: ["follow_up.create"], expectedVersion: 2, idempotencyKey: "configure-paused-0001" })).rejects.toMatchObject({ code: "paused" });
    await expect(service.authorize(agent, "follow_up.create", "team-a")).rejects.toMatchObject({ code: "paused" });
    const resumed = await service.changeStatus(manager, { policyId: first.policyId, expectedVersion: 2, status: "active", reason: "继续处理", idempotencyKey: "resume-0001" });
    await expect(service.authorize(agent, "follow_up.create", "team-a")).resolves.toBeUndefined();
    await service.changeStatus(manager, { policyId: first.policyId, expectedVersion: resumed.version, status: "revoked", reason: "撤权", idempotencyKey: "revoke-0001" });
    await expect(service.authorize(agent, "follow_up.create", "team-a")).rejects.toMatchObject({ code: "revoked" });
    await expect(service.configure(manager, { agentSubject: "agent", workspaceSlug: "team-a", actions: ["follow_up.create"], expectedVersion: 4, idempotencyKey: "configure-revoked-0001" })).rejects.toMatchObject({ code: "revoked" });
    expect(store.audits.map((row) => row.event)).toEqual(["configured", "paused", "resumed", "revoked"]);
  });

  test("非 agent 身份不受 agent 策略代替，人类接管不依赖 agent 在线", async () => {
    const service = new OpsAutonomyService(new MemoryStore());
    await expect(service.authorize(manager, "follow_up.update", "team-a")).resolves.toBeUndefined();
    await expect(service.configure(agent, { agentSubject: "agent", workspaceSlug: "team-a", actions: [] as OpsAutonomyAction[], expectedVersion: null, idempotencyKey: "agent-config-denied" })).rejects.toMatchObject({ code: "human_required" });
  });
});
