import type { ActivationOpportunity, FollowUpItem, OpsProposal, OpsRun, SaveOpsRun } from "@surreal-ck/shared";
import { createHash } from "node:crypto";
import { hasCurrentFollowUpSource } from "../ops-follow-up/premise";

export interface OpsMcpPort {
  call<T>(tool: string, args: Record<string, unknown>): Promise<T>;
}
export type RunnerBudget = { maxActions: number; maxRetries: number; maxDurationMs: number; intervalMs: number };
const defaultBudget: RunnerBudget = { maxActions: 20, maxRetries: 3, maxDurationMs: 60_000, intervalMs: 3_600_000 };
type OpportunityPage = { items: ActivationOpportunity[]; nextCursor: string | null };
type FollowUpPage = { items: FollowUpItem[]; nextCursor: string | null };
type CheckpointResponse = { item: OpsRun | null };
type Pending = NonNullable<SaveOpsRun["pendingAction"]>;

function pending(tool: Pending["tool"], targetId: string, idempotencyKey: string, args: Record<string, unknown>): Pending {
  return { tool, targetId, idempotencyKey, argsJson: JSON.stringify(args) };
}
function key(runKey: string, opportunityId: string, stage: string): string {
  return `agent-${createHash("sha256").update(`${runKey}:${opportunityId}:${stage}`).digest("hex").slice(0, 40)}-${stage}`;
}
function dueKey(item: FollowUpItem): string {
  return `due:${createHash("sha256").update(`${item.followUpId}:${item.dueCheckAt}`).digest("hex").slice(0, 40)}`;
}
function nextState(run: OpsRun, change: Partial<SaveOpsRun>): SaveOpsRun {
  return { runKey: run.runKey, workspaceSlug: run.workspaceSlug, expectedVersion: run.version,
    status: change.status ?? run.status, cursor: change.cursor === undefined ? run.cursor : change.cursor,
    processedIds: change.processedIds ?? run.processedIds, trackedProposalIds: change.trackedProposalIds ?? run.trackedProposalIds,
    pendingAction: change.pendingAction === undefined ? run.pendingAction : change.pendingAction,
    dueCheckAt: change.dueCheckAt === undefined ? run.dueCheckAt : change.dueCheckAt,
    retryCount: change.retryCount ?? run.retryCount, lastErrorCode: change.lastErrorCode === undefined ? run.lastErrorCode : change.lastErrorCode,
    actionsCompleted: change.actionsCompleted ?? run.actionsCompleted };
}

/** 单次外部进程驱动；不自建常驻调度。每个副作用先持久化待核实调用，再用稳定幂等键确认结果。 */
export class ExternalOpsAgentRunner {
  constructor(private readonly mcp: OpsMcpPort, private readonly now: () => Date = () => new Date()) {}
  private async findFollowUp(followUpId: string, deadline: number): Promise<FollowUpItem | null> {
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < 20 && this.now().getTime() < deadline; pageNumber++) {
      const page: FollowUpPage = await this.mcp.call<FollowUpPage>("list_follow_ups", { limit: 50, cursor });
      const found = page.items.find((item) => item.followUpId === followUpId);
      if (found) return found;
      if (!page.nextCursor) return null;
      cursor = page.nextCursor;
    }
    return null;
  }
  private async checkTracked(run: OpsRun, deadline: number): Promise<OpsRun> {
    for (const proposalId of [...run.trackedProposalIds]) {
      const proposal = await this.mcp.call<OpsProposal>("get_ops_proposal", { proposalId });
      if (proposal.status === "failed" || proposal.status === "stale" || proposal.status === "rejected") {
        return await this.save(run, { status: "needs_human", lastErrorCode: `proposal_${proposal.status}` });
      }
      if (proposal.status !== "succeeded") continue;
      if (proposal.toolResult?.code !== "action_succeeded") {
        return await this.save(run, { status: "needs_human", lastErrorCode: "proposal_result_unverified" });
      }
      const item = proposal.actionFollowUpVersion ? await this.findFollowUp(proposal.followUpId, deadline) : null;
      if (item && proposal.actionFollowUpVersion && item.version >= proposal.actionFollowUpVersion) {
        run = await this.save(run, { trackedProposalIds: run.trackedProposalIds.filter((id) => id !== proposalId) });
      }
    }
    return run;
  }
  private async dueItem(run: OpsRun, deadline: number, skipped: ReadonlySet<string>): Promise<{ item: FollowUpItem; key: string } | null> {
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < 20 && this.now().getTime() < deadline; pageNumber++) {
      const page: FollowUpPage = await this.mcp.call<FollowUpPage>("list_follow_ups", { limit: 50, cursor });
      const item = page.items.find((row) => {
        return row.workspaceSlug === run.workspaceSlug && row.dueCheckAt !== null
          && Date.parse(row.dueCheckAt) <= this.now().getTime() && row.status !== "resolved" && row.status !== "dismissed"
          && !run.processedIds.includes(dueKey(row)) && !skipped.has(dueKey(row));
      });
      if (item) return { item, key: dueKey(item) };
      if (!page.nextCursor) return null;
      cursor = page.nextCursor;
    }
    return null;
  }
  private async save(run: OpsRun, change: Partial<SaveOpsRun>): Promise<OpsRun> {
    return await this.mcp.call<OpsRun>("save_agent_run_checkpoint", nextState(run, change));
  }
  async run(input: { runKey: string; workspaceSlug: string; budget?: Partial<RunnerBudget> }): Promise<OpsRun> {
    const budget = { ...defaultBudget, ...input.budget };
    if (!Number.isInteger(budget.maxActions) || budget.maxActions < 1 || !Number.isInteger(budget.maxRetries) || budget.maxRetries < 1
      || !Number.isFinite(budget.maxDurationMs) || budget.maxDurationMs < 1000 || !Number.isFinite(budget.intervalMs) || budget.intervalMs < 1000) throw new Error("invalid runner budget");
    const deadline = this.now().getTime() + budget.maxDurationMs;
    const found = await this.mcp.call<CheckpointResponse>("get_agent_run_checkpoint", { runKey: input.runKey, workspaceSlug: input.workspaceSlug });
    let run = found.item ?? await this.mcp.call<OpsRun>("save_agent_run_checkpoint", {
      runKey: input.runKey, workspaceSlug: input.workspaceSlug, expectedVersion: null, status: "running", cursor: null,
      processedIds: [], trackedProposalIds: [], pendingAction: null, dueCheckAt: null, retryCount: 0, lastErrorCode: null, actionsCompleted: 0,
    } satisfies SaveOpsRun);
    if (run.status === "needs_human") return run;
    run = await this.checkTracked(run, deadline);
    if (run.status === "needs_human") return run;
    if (run.status === "waiting" && run.dueCheckAt && Date.parse(run.dueCheckAt) > this.now().getTime()) return run;
    run = await this.save(run, { status: "running", dueCheckAt: null });
    let actionsThisRound = 0;
    let steps = 0;
    const skippedDue = new Set<string>();
    let nextLeaseCheckAt: number | null = null;
    while (actionsThisRound < budget.maxActions && steps++ < budget.maxActions * 10 && this.now().getTime() < deadline) {
      if (run.pendingAction) {
        const action = run.pendingAction;
        try {
          const args = JSON.parse(action.argsJson) as Record<string, unknown>;
          const verified = await this.mcp.call<{ item: FollowUpItem | { proposalId: string } | null }>("verify_ops_action", {
            tool: action.tool, ...args,
          });
          const result = verified.item ?? await this.mcp.call<FollowUpItem | { proposalId: string }>(action.tool, args);
          if (!verified.item) actionsThisRound++;
          if (action.tool === "create_follow_up") {
            const item = result as FollowUpItem;
            if (item.nextStep !== "claim") {
              run = await this.save(run, { pendingAction: null, processedIds: [...run.processedIds.slice(-498), action.targetId],
                actionsCompleted: run.actionsCompleted + 1, retryCount: 0 });
              continue;
            }
            const nextKey = key(run.runKey, action.targetId, "claim");
            run = await this.save(run, { pendingAction: pending("claim_follow_up", action.targetId, nextKey,
              { followUpId: item.followUpId, expectedVersion: item.version, leaseSeconds: 900, idempotencyKey: nextKey }),
              actionsCompleted: run.actionsCompleted + 1, retryCount: 0 });
            continue;
          }
          if (action.tool === "claim_follow_up") {
            const item = result as FollowUpItem;
            const nextKey = key(run.runKey, action.targetId, "proposal");
            run = await this.save(run, { pendingAction: pending("submit_ops_proposal", action.targetId, nextKey, {
              followUpId: item.followUpId, followUpVersion: item.version, summaryUpdatedAt: item.sourceUpdatedAt,
              action: { type: "follow_up.update", status: "waiting", dueCheckAt: new Date(this.now().getTime() + budget.intervalMs).toISOString(), result: null },
              rationale: "新鲜启用摘要提示需核查；仅建议内部等待并由人工审阅。",
              expectedResult: "后续核查有可验证的新证据，再由人工决定是否关闭。",
              triggerReason: action.targetId.startsWith("due:") ? "scheduled_check" : "fresh_activation_opportunity",
              inputSummary: action.targetId.startsWith("due:") ? action.targetId : `opportunity:${action.targetId}`,
              idempotencyKey: nextKey,
            }), actionsCompleted: run.actionsCompleted + 1, retryCount: 0 });
            continue;
          }
          let trackedProposalIds = run.trackedProposalIds;
          if (action.tool === "submit_ops_proposal") {
            const proposalId = (result as { proposalId: string }).proposalId;
            const proposal = await this.mcp.call<OpsProposal>("get_ops_proposal", { proposalId });
            if (proposal.status !== "pending" && proposal.status !== "approved" && proposal.status !== "executing" && proposal.status !== "succeeded") {
              return await this.save(run, { status: "needs_human", lastErrorCode: `proposal_${proposal.status}` });
            }
            trackedProposalIds = [...new Set([...run.trackedProposalIds, proposalId])];
            if (trackedProposalIds.length > 500) return await this.save(run, { status: "needs_human", lastErrorCode: "proposal_tracking_limit" });
          }
          run = await this.save(run, { pendingAction: null,
            processedIds: [...run.processedIds.slice(-498), action.targetId],
            trackedProposalIds, actionsCompleted: run.actionsCompleted + 1, retryCount: 0 });
          continue;
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error)) throw error;
          const code = String(error.code);
          if (code === "paused") {
            await this.save(run, { status: "waiting", lastErrorCode: code, dueCheckAt: new Date(this.now().getTime() + budget.intervalMs).toISOString() });
            throw error;
          }
          if (["revoked", "out_of_scope", "capability_missing"].includes(code)) {
            await this.save(run, { status: "needs_human", lastErrorCode: code, dueCheckAt: null });
            throw error;
          }
          if (["conflict", "not_found", "invalid_request"].includes(code)) {
            return await this.save(run, { status: "needs_human", lastErrorCode: code, retryCount: run.retryCount + 1 });
          }
          const retryCount = run.retryCount + 1;
          run = await this.save(run, { retryCount, lastErrorCode: code, status: retryCount >= budget.maxRetries ? "needs_human" : "waiting",
            dueCheckAt: retryCount >= budget.maxRetries ? null : new Date(this.now().getTime() + budget.intervalMs).toISOString() });
          return run;
        }
      }
      const page = await this.mcp.call<OpportunityPage>("list_activation_opportunities", { limit: 50, cursor: run.cursor });
      const item = page.items.find((candidate) => candidate.workspaceSlug === run.workspaceSlug && !run.processedIds.includes(candidate.opportunityId));
      if (item) {
        const actionKey = key(run.runKey, item.opportunityId, "create");
        run = await this.save(run, { pendingAction: pending("create_follow_up", item.opportunityId, actionKey,
          { opportunityId: item.opportunityId, dueCheckAt: null, idempotencyKey: actionKey }) });
        continue;
      }
      if (page.nextCursor) { run = await this.save(run, { cursor: page.nextCursor }); continue; }
      const due = await this.dueItem(run, deadline, skippedDue);
      if (due) {
        if (!hasCurrentFollowUpSource(due.item)) {
          return await this.save(run, { status: "needs_human", lastErrorCode: "due_source_unavailable_or_stale", cursor: null });
        }
        if (due.item.nextStep === "claim") {
          const actionKey = key(run.runKey, due.key, "claim");
          run = await this.save(run, { cursor: null, pendingAction: pending("claim_follow_up", due.key, actionKey,
            { followUpId: due.item.followUpId, expectedVersion: due.item.version, leaseSeconds: 900, idempotencyKey: actionKey }) });
          continue;
        }
        if (due.item.nextStep === "update") {
          const actionKey = key(run.runKey, due.key, "proposal");
          run = await this.save(run, { cursor: null, pendingAction: pending("submit_ops_proposal", due.key, actionKey, {
            followUpId: due.item.followUpId, followUpVersion: due.item.version, summaryUpdatedAt: due.item.sourceUpdatedAt,
            action: { type: "follow_up.update", status: "waiting", dueCheckAt: new Date(this.now().getTime() + budget.intervalMs).toISOString(), result: null },
            rationale: "到期核查后仅确认当前摘要可用；尚无客户问题已解决的新证据。", expectedResult: "请人工核实新证据并决定下一步。",
            triggerReason: "scheduled_check", inputSummary: due.key, idempotencyKey: actionKey,
          }) });
          continue;
        }
        skippedDue.add(due.key);
        const leaseEnd = due.item.leaseExpiresAt ? Date.parse(due.item.leaseExpiresAt) : Number.NaN;
        if (Number.isFinite(leaseEnd) && leaseEnd > this.now().getTime()) nextLeaseCheckAt = Math.min(nextLeaseCheckAt ?? leaseEnd, leaseEnd);
        continue;
      }
      return await this.save(run, { status: "waiting", cursor: null, dueCheckAt: new Date(Math.min(this.now().getTime() + budget.intervalMs, nextLeaseCheckAt ?? Infinity)).toISOString() });
    }
    if (actionsThisRound >= budget.maxActions || this.now().getTime() >= deadline) {
      return await this.save(run, { status: "needs_human", lastErrorCode: actionsThisRound >= budget.maxActions ? "action_budget_exhausted" : "time_budget_exhausted", dueCheckAt: null });
    }
    return await this.save(run, { status: "waiting", dueCheckAt: new Date(this.now().getTime() + budget.intervalMs).toISOString() });
  }
}
