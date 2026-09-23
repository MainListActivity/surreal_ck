import { describe, expect, test } from "bun:test";
import type { OpsRun, SaveOpsRun } from "@surreal-ck/shared";
import { ExternalOpsAgentRunner, type OpsMcpPort } from "./runner";

const opportunityId = "opportunity:alpha";
class FakeMcp implements OpsMcpPort {
  run: OpsRun | null = null;
  effects = { create: 0, claim: 0, proposal: 0 };
  keys = new Set<string>();
  outcomes = new Map<string, unknown>();
  createCalls = 0;
  crashAfterCreate = false;
  proposal: Record<string, unknown> = { proposalId: "ops_proposal:1", status: "pending" };
  followUps: unknown[] = [];
  async call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
    if (tool === "get_agent_run_checkpoint") return { item: this.run } as T;
    if (tool === "save_agent_run_checkpoint") {
      const input = args as SaveOpsRun;
      if ((this.run?.version ?? null) !== input.expectedVersion) throw { code: "conflict" };
      if (this.crashAfterCreate && this.keys.size > 0 && this.run?.pendingAction?.tool === "create_follow_up") {
        this.crashAfterCreate = false;
        throw new Error("runner killed after external side effect");
      }
      this.run = { ...input, version: (this.run?.version ?? 0) + 1, runId: "ops_agent_run:1", agentSubject: "agent",
        updatedAt: "2026-09-22T12:00:00.000Z" };
      return this.run as T;
    }
    if (tool === "list_activation_opportunities") return { items: [{ opportunityId, workspaceSlug: "team-a" }], nextCursor: null } as T;
    if (tool === "list_follow_ups") return { items: this.followUps, nextCursor: null } as T;
    if (tool === "verify_ops_action") return { item: this.outcomes.get(String(args.idempotencyKey)) ?? null } as T;
    const key = String(args.idempotencyKey);
    if (tool === "create_follow_up") this.createCalls++;
    if (!this.keys.has(key)) {
      this.keys.add(key);
      if (tool === "create_follow_up") this.effects.create++;
      if (tool === "claim_follow_up") this.effects.claim++;
      if (tool === "submit_ops_proposal") this.effects.proposal++;
    }
    if (tool === "create_follow_up") { const result = { followUpId: "activation_follow_up:1", version: 1, nextStep: "claim", sourceUpdatedAt: "2026-09-22T12:00:00.000Z" }; this.outcomes.set(key, result); return result as T; }
    if (tool === "claim_follow_up") { const result = { followUpId: "activation_follow_up:1", version: 2, nextStep: "update", sourceUpdatedAt: "2026-09-22T12:00:00.000Z" }; this.outcomes.set(key, result); return result as T; }
    if (tool === "submit_ops_proposal") { const result = { proposalId: "ops_proposal:1" }; this.outcomes.set(key, result); return result as T; }
    if (tool === "get_ops_proposal") return this.proposal as T;
    throw new Error(`unknown tool ${tool}`);
  }
}

describe("external ops runner", () => {
  test("中断后先核实待完成工具结果，成功副作用不重复", async () => {
    const mcp = new FakeMcp();
    mcp.crashAfterCreate = true;
    const runner = new ExternalOpsAgentRunner(mcp, () => new Date("2026-09-22T12:00:00.000Z"));
    await expect(runner.run({ runKey: "daily-001", workspaceSlug: "team-a" })).rejects.toThrow("runner killed");
    expect(mcp.run?.pendingAction?.tool).toBe("create_follow_up");
    const resumed = await runner.run({ runKey: "daily-001", workspaceSlug: "team-a" });
    expect(mcp.effects).toEqual({ create: 1, claim: 1, proposal: 1 });
    expect(mcp.createCalls).toBe(1);
    expect(resumed.processedIds).toEqual([opportunityId]);
    expect(resumed.status).toBe("waiting");
    expect((await runner.run({ runKey: "daily-001", workspaceSlug: "team-a" })).actionsCompleted).toBe(3);
  });
  test("重试耗尽转待人工处理，不静默无限循环", async () => {
    const mcp = new FakeMcp();
    const original = mcp.call.bind(mcp);
    mcp.call = async <T>(tool: string, args: Record<string, unknown>) => {
      if (tool === "create_follow_up") throw { code: "upstream_unavailable" };
      return await original<T>(tool, args);
    };
    let now = Date.parse("2026-09-22T12:00:00.000Z");
    const runner = new ExternalOpsAgentRunner(mcp, () => new Date(now));
    const budget = { maxRetries: 2, intervalMs: 1000 };
    expect((await runner.run({ runKey: "daily-002", workspaceSlug: "team-a", budget })).status).toBe("waiting");
    now += 1000;
    const final = await runner.run({ runKey: "daily-002", workspaceSlug: "team-a", budget });
    expect(final).toMatchObject({ status: "needs_human", retryCount: 2, lastErrorCode: "upstream_unavailable" });
  });
  test("到期但来源陈旧时转人工，不提交解决建议", async () => {
    const mcp = new FakeMcp();
    const original = mcp.call.bind(mcp);
    mcp.call = async <T>(tool: string, args: Record<string, unknown>) => {
      if (tool === "list_activation_opportunities") return { items: [], nextCursor: null } as T;
      if (tool === "list_follow_ups") return { items: [{ followUpId: "activation_follow_up:1", workspaceSlug: "team-a",
        status: "waiting", dueCheckAt: "2026-09-21T12:00:00.000Z", sourceAvailable: true, sourceFreshness: "stale", nextStep: "claim" }], nextCursor: null } as T;
      return await original<T>(tool, args);
    };
    const runner = new ExternalOpsAgentRunner(mcp, () => new Date("2026-09-22T12:00:00.000Z"));
    const run = await runner.run({ runKey: "daily-003", workspaceSlug: "team-a" });
    expect(run).toMatchObject({ status: "needs_human", lastErrorCode: "due_source_unavailable_or_stale" });
    expect(mcp.effects).toEqual({ create: 0, claim: 0, proposal: 0 });
  });
  test("租约过期的到期事项重新认领并形成待审核查建议，重复轮次不重放", async () => {
    const mcp = new FakeMcp();
    const original = mcp.call.bind(mcp);
    mcp.call = async <T>(tool: string, args: Record<string, unknown>) => {
      if (tool === "list_activation_opportunities") return { items: [], nextCursor: null } as T;
      if (tool === "list_follow_ups") return { items: [{ followUpId: "activation_follow_up:1", workspaceSlug: "team-a", version: 1,
        status: "waiting", dueCheckAt: "2026-09-21T12:00:00.000Z", sourceAvailable: true, sourceFreshness: "fresh", nextStep: "claim" }], nextCursor: null } as T;
      return await original<T>(tool, args);
    };
    const runner = new ExternalOpsAgentRunner(mcp, () => new Date("2026-09-22T12:00:00.000Z"));
    const run = await runner.run({ runKey: "daily-lease-001", workspaceSlug: "team-a" });
    expect(run.status).toBe("waiting");
    expect(mcp.effects).toEqual({ create: 0, claim: 1, proposal: 1 });
    expect(run.processedIds[0]).toStartWith("due:");
    expect((await runner.run({ runKey: "daily-lease-001", workspaceSlug: "team-a" })).actionsCompleted).toBe(2);
  });
  test("暂停在读取边界阻断新一轮动作", async () => {
    const mcp = new FakeMcp();
    mcp.call = async <T>() => { throw { code: "paused" } as T; };
    const runner = new ExternalOpsAgentRunner(mcp);
    await expect(runner.run({ runKey: "daily-004", workspaceSlug: "team-a" })).rejects.toMatchObject({ code: "paused" });
    expect(mcp.effects.create).toBe(0);
  });
  test("撤权在读取边界阻断新一轮动作", async () => {
    const mcp = new FakeMcp();
    mcp.call = async <T>() => { throw { code: "revoked" } as T; };
    await expect(new ExternalOpsAgentRunner(mcp).run({ runKey: "daily-005", workspaceSlug: "team-a" })).rejects.toMatchObject({ code: "revoked" });
    expect(mcp.effects.create).toBe(0);
  });
  test("他人持有租约时跳过该事项并继续处理后续到期项", async () => {
    const mcp = new FakeMcp();
    const original = mcp.call.bind(mcp);
    mcp.call = async <T>(tool: string, args: Record<string, unknown>) => {
      if (tool === "list_activation_opportunities") return { items: [], nextCursor: null } as T;
      if (tool === "list_follow_ups") return { items: [
        { followUpId: "activation_follow_up:held", workspaceSlug: "team-a", version: 2, status: "claimed",
          dueCheckAt: "2026-09-21T12:00:00.000Z", sourceAvailable: true, sourceFreshness: "fresh", nextStep: "none",
          leaseExpiresAt: "2026-09-22T12:30:00.000Z" },
        { followUpId: "activation_follow_up:1", workspaceSlug: "team-a", version: 1, status: "waiting",
          dueCheckAt: "2026-09-21T12:00:00.000Z", sourceAvailable: true, sourceFreshness: "fresh", nextStep: "claim" },
      ], nextCursor: null } as T;
      return await original<T>(tool, args);
    };
    const run = await new ExternalOpsAgentRunner(mcp, () => new Date("2026-09-22T12:00:00.000Z"))
      .run({ runKey: "daily-lease-held", workspaceSlug: "team-a" });
    expect(run.status).toBe("waiting");
    expect(run.lastErrorCode).toBeNull();
    expect(run.dueCheckAt).toBe("2026-09-22T12:30:00.000Z");
    expect(mcp.effects).toEqual({ create: 0, claim: 1, proposal: 1 });
  });
  test("等待窗口内事项版本尚未追上时继续跟踪，不把建议当成已证实", async () => {
    const mcp = new FakeMcp();
    const runner = new ExternalOpsAgentRunner(mcp, () => new Date("2026-09-22T12:00:00.000Z"));
    const first = await runner.run({ runKey: "daily-track-001", workspaceSlug: "team-a" });
    expect(first.trackedProposalIds).toEqual(["ops_proposal:1"]);
    expect(first.status).toBe("waiting");
    mcp.proposal = { proposalId: "ops_proposal:1", status: "succeeded", followUpId: "activation_follow_up:1",
      actionFollowUpVersion: 4, toolResult: { code: "action_succeeded" } };
    mcp.followUps = [{ followUpId: "activation_follow_up:1", workspaceSlug: "team-a", version: 3, status: "waiting",
      dueCheckAt: null, sourceAvailable: true, sourceFreshness: "fresh", nextStep: "update" }];
    const second = await runner.run({ runKey: "daily-track-001", workspaceSlug: "team-a" });
    expect(second.status).toBe("waiting");
    expect(second.trackedProposalIds).toEqual(["ops_proposal:1"]);
    expect(mcp.effects).toEqual({ create: 1, claim: 1, proposal: 1 });
  });
  test("等待窗口内已证实的建议取消跟踪，且不重放动作", async () => {
    const mcp = new FakeMcp();
    const runner = new ExternalOpsAgentRunner(mcp, () => new Date("2026-09-22T12:00:00.000Z"));
    const first = await runner.run({ runKey: "daily-track-002", workspaceSlug: "team-a" });
    mcp.proposal = { proposalId: "ops_proposal:1", status: "succeeded", followUpId: "activation_follow_up:1",
      actionFollowUpVersion: 3, toolResult: { code: "action_succeeded" } };
    mcp.followUps = [{ followUpId: "activation_follow_up:1", workspaceSlug: "team-a", version: 3, status: "waiting",
      dueCheckAt: null, sourceAvailable: true, sourceFreshness: "fresh", nextStep: "update" }];
    const second = await runner.run({ runKey: "daily-track-002", workspaceSlug: "team-a" });
    expect(second.status).toBe("waiting");
    expect(second.trackedProposalIds).toEqual([]);
    expect(second.dueCheckAt).toBe(first.dueCheckAt);
    expect(second.actionsCompleted).toBe(first.actionsCompleted);
    expect(mcp.effects).toEqual({ create: 1, claim: 1, proposal: 1 });
  });
  test("等待窗口内建议失败则转人工，且不重放动作", async () => {
    const mcp = new FakeMcp();
    const runner = new ExternalOpsAgentRunner(mcp, () => new Date("2026-09-22T12:00:00.000Z"));
    await runner.run({ runKey: "daily-track-003", workspaceSlug: "team-a" });
    mcp.proposal = { proposalId: "ops_proposal:1", status: "failed", followUpId: "activation_follow_up:1" };
    const second = await runner.run({ runKey: "daily-track-003", workspaceSlug: "team-a" });
    expect(second).toMatchObject({ status: "needs_human", lastErrorCode: "proposal_failed" });
    expect(mcp.effects).toEqual({ create: 1, claim: 1, proposal: 1 });
  });
  test("核实待完成动作时暂停，检查点不再停在运行中", async () => {
    const mcp = new FakeMcp();
    mcp.crashAfterCreate = true;
    const runner = new ExternalOpsAgentRunner(mcp, () => new Date("2026-09-22T12:00:00.000Z"));
    await expect(runner.run({ runKey: "daily-pause-mid", workspaceSlug: "team-a" })).rejects.toThrow("runner killed");
    const original = mcp.call.bind(mcp);
    mcp.call = async <T>(tool: string, args: Record<string, unknown>) => {
      if (tool === "verify_ops_action") throw { code: "paused" };
      return await original<T>(tool, args);
    };
    await expect(runner.run({ runKey: "daily-pause-mid", workspaceSlug: "team-a" })).rejects.toMatchObject({ code: "paused" });
    expect(mcp.run).toMatchObject({ status: "waiting", lastErrorCode: "paused" });
  });
  test("单轮动作预算耗尽转待人工，而非无界续跑", async () => {
    const mcp = new FakeMcp();
    const run = await new ExternalOpsAgentRunner(mcp, () => new Date("2026-09-22T12:00:00.000Z"))
      .run({ runKey: "daily-budget-001", workspaceSlug: "team-a", budget: { maxActions: 1 } });
    expect(run).toMatchObject({ status: "needs_human", lastErrorCode: "action_budget_exhausted" });
    expect(run.pendingAction?.tool).toBe("claim_follow_up");
  });
});
