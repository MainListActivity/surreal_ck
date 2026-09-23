import { describe, expect, test } from "bun:test";
import type { OpsRun, SaveOpsRun } from "@surreal-ck/shared";
import { ExternalOpsAgentRunner, type OpsMcpPort } from "./runner";

const opportunityId = "opportunity:alpha";
class FakeMcp implements OpsMcpPort {
  run: OpsRun | null = null;
  effects = { create: 0, claim: 0, proposal: 0 };
  keys = new Set<string>();
  crashAfterCreate = false;
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
    if (tool === "list_follow_ups") return { items: [], nextCursor: null } as T;
    const key = String(args.idempotencyKey);
    if (!this.keys.has(key)) {
      this.keys.add(key);
      if (tool === "create_follow_up") this.effects.create++;
      if (tool === "claim_follow_up") this.effects.claim++;
      if (tool === "submit_ops_proposal") this.effects.proposal++;
    }
    if (tool === "create_follow_up") return { followUpId: "activation_follow_up:1", version: 1, nextStep: "claim", sourceUpdatedAt: "2026-09-22T12:00:00.000Z" } as T;
    if (tool === "claim_follow_up") return { followUpId: "activation_follow_up:1", version: 2, nextStep: "update", sourceUpdatedAt: "2026-09-22T12:00:00.000Z" } as T;
    if (tool === "submit_ops_proposal") return { proposalId: "ops_proposal:1" } as T;
    if (tool === "get_ops_proposal") return { proposalId: "ops_proposal:1", status: "pending" } as T;
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
});
