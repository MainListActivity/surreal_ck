import { createHash } from "node:crypto";
import { executeOpsProposalSchema, reviewOpsProposalSchema, submitOpsProposalSchema, takeoverFollowUpSchema, type FollowUpItem, type OpsProposal, type OpsProposalAction, type OpsProposalPage } from "@surreal-ck/shared";
import type { OpsFollowUpActor } from "../ops-follow-up/service";
import { OpsAutonomyError, type OpsAutonomyService } from "../ops-autonomy/service";

export type OpsProposalActor = OpsFollowUpActor & { kind?: "human" | "agent"; agentId?: string | null };
export type OpsProposalCursor = { updatedAt: string; proposalId: string };
export interface OpsProposalStore {
  getFollowUp(followUpId: string): Promise<FollowUpItem | null>;
  getSummaryUpdatedAt(summaryId: string): Promise<string | null>;
  findByIdempotency(actorSubject: string, idempotencyKey: string): Promise<{ item: OpsProposal; requestDigest: string } | null>;
  get(proposalId: string): Promise<OpsProposal | null>;
  list(input: { limit: number; cursor: OpsProposalCursor | null; workspaceSlugs?: readonly string[] | null }): Promise<OpsProposal[]>;
  create(input: { followUpId: string; summaryId: string; summaryUpdatedAt: string; followUpVersion: number; action: OpsProposalAction; rationale: string; expectedResult: string; triggerReason: string; inputSummary: string; actorSubject: string; agentId: string | null; idempotencyKey: string; requestDigest: string }): Promise<OpsProposal>;
  review(input: { proposalId: string; expectedVersion: number; actionDigest: string; decision: "approve" | "reject"; reason: string; actorSubject: string; agentId: string | null; idempotencyKey: string; requestDigest: string }): Promise<OpsProposal | null>;
  reserve(input: { proposalId: string; expectedVersion: number; actorSubject: string; agentId: string | null; idempotencyKey: string; requestDigest: string }): Promise<OpsProposal | null>;
  finish(input: { proposalId: string; expectedVersion: number; status: "succeeded" | "failed" | "stale"; toolResult: NonNullable<OpsProposal["toolResult"]>; actionFollowUpVersion: number | null; actorSubject: string; agentId: string | null; idempotencyKey: string; requestDigest: string }): Promise<OpsProposal | null>;
  takeover(input: { followUpId: string; expectedVersion: number; leaseExpiresAt: string; reason: string; actorSubject: string; idempotencyKey: string; requestDigest: string }): Promise<FollowUpItem | null>;
  findTakeoverIdempotency(actorSubject: string, idempotencyKey: string): Promise<{ item: FollowUpItem; requestDigest: string } | null>;
  findAppliedAction(actorSubject: string, idempotencyKey: string, followUpId: string): Promise<{ followUpVersion: number } | null>;
}
export type FollowUpActions = {
  claim(actor: OpsFollowUpActor, input: { followUpId: string; expectedVersion: number; leaseSeconds: number; idempotencyKey: string; sourceSummaryId?: string; sourceUpdatedAt?: string }): Promise<FollowUpItem>;
  update(actor: OpsFollowUpActor, input: { followUpId: string; expectedVersion: number; status: "waiting" | "resolved" | "dismissed"; dueCheckAt: string | null; result: string | null; idempotencyKey: string; sourceSummaryId?: string; sourceUpdatedAt?: string }): Promise<FollowUpItem>;
};
export class OpsProposalServiceError extends Error {
  constructor(readonly code: "invalid_request" | "capability_missing" | "not_found" | "conflict", message: string) { super(message); this.name = "OpsProposalServiceError"; }
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]));
  return value;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
export const digestProposalAction = (action: OpsProposalAction): string => digest(action);
function requireCapability(actor: OpsProposalActor, capability: string) {
  if (!actor.capabilities.includes(capability)) throw new OpsProposalServiceError("capability_missing", `缺少 ${capability} 能力`);
}
function cursor(value?: string): OpsProposalCursor | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as OpsProposalCursor;
    if (typeof decoded.updatedAt === "string" && typeof decoded.proposalId === "string" && decoded.proposalId.startsWith("ops_proposal:")) return decoded;
  } catch { /* invalid cursor */ }
  throw new OpsProposalServiceError("invalid_request", "分页游标无效");
}

export class OpsProposalService {
  constructor(private readonly store: OpsProposalStore, private readonly actions: FollowUpActions,
    private readonly autonomy?: Pick<OpsAutonomyService, "authorize" | "allowedWorkspaces">) {}
  private async authorize(actor: OpsProposalActor, action: "proposal.read" | "proposal.submit" | "proposal.execute", workspaceSlug: string): Promise<void> {
    if (!this.autonomy && actor.kind === "agent") throw new OpsAutonomyError("out_of_scope", "agent 自治授权服务不可用");
    await this.autonomy?.authorize(actor, action, workspaceSlug);
  }
  actionDigest(action: OpsProposalAction): string { return digestProposalAction(action); }

  async list(actor: OpsProposalActor, input: { limit?: number; cursor?: string }): Promise<OpsProposalPage> {
    requireCapability(actor, "activation.proposal.read");
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1) throw new OpsProposalServiceError("invalid_request", "limit 必须是正整数");
    if (!this.autonomy && actor.kind === "agent") throw new OpsAutonomyError("out_of_scope", "agent 自治授权服务不可用");
    const workspaceSlugs = await this.autonomy?.allowedWorkspaces(actor, "proposal.read") ?? null;
    const rows = await this.store.list({ limit: Math.min(limit, 100) + 1, cursor: cursor(input.cursor), workspaceSlugs });
    const items = rows.slice(0, Math.min(limit, 100));
    const tail = items.at(-1);
    return { items, nextCursor: rows.length > items.length && tail ? Buffer.from(JSON.stringify({ updatedAt: tail.updatedAt, proposalId: tail.proposalId })).toString("base64url") : null };
  }

  async get(actor: OpsProposalActor, proposalId: string): Promise<OpsProposal> {
    requireCapability(actor, "activation.proposal.read");
    if (!proposalId.startsWith("ops_proposal:")) throw new OpsProposalServiceError("invalid_request", "建议 ID 无效");
    const proposal = await this.store.get(proposalId);
    if (!proposal) throw new OpsProposalServiceError("not_found", "建议不存在");
    const followUp = await this.store.getFollowUp(proposal.followUpId);
    if (!followUp) throw new OpsProposalServiceError("not_found", "跟进事项不存在");
    await this.authorize(actor, "proposal.read", followUp.workspaceSlug);
    return proposal;
  }

  private async replay(actor: OpsProposalActor, key: string, requestDigest: string): Promise<OpsProposal | null> {
    const prior = await this.store.findByIdempotency(actor.subject, key);
    if (!prior) return null;
    if (prior.requestDigest !== requestDigest) throw new OpsProposalServiceError("conflict", "幂等键已用于不同请求");
    return prior.item;
  }
  async verifySubmittedAction(actor: OpsProposalActor, input: unknown): Promise<OpsProposal | null> {
    const parsed = submitOpsProposalSchema.safeParse(input);
    if (!parsed.success) throw new OpsProposalServiceError("invalid_request", "建议请求无效");
    const body = parsed.data;
    const replay = await this.replay(actor, body.idempotencyKey, digest({ event: "submit", body }));
    if (!replay) return null;
    const followUp = await this.store.getFollowUp(replay.followUpId);
    if (!followUp) throw new OpsProposalServiceError("not_found", "跟进事项不存在");
    await this.authorize(actor, "proposal.submit", followUp.workspaceSlug);
    return replay;
  }

  async submit(actor: OpsProposalActor, input: unknown): Promise<OpsProposal> {
    requireCapability(actor, "activation.proposal.submit");
    requireCapability(actor, "activation.proposal.read");
    requireCapability(actor, "activation.followup.read");
    const parsed = submitOpsProposalSchema.safeParse(input);
    if (!parsed.success) throw new OpsProposalServiceError("invalid_request", "建议请求无效");
    const body = parsed.data;
    const requestDigest = digest({ event: "submit", body });
    const replay = await this.replay(actor, body.idempotencyKey, requestDigest);
    if (replay) {
      const priorFollowUp = await this.store.getFollowUp(replay.followUpId);
      if (!priorFollowUp) throw new OpsProposalServiceError("not_found", "跟进事项不存在");
      await this.authorize(actor, "proposal.submit", priorFollowUp.workspaceSlug);
      return replay;
    }
    const item = await this.store.getFollowUp(body.followUpId);
    if (!item) throw new OpsProposalServiceError("not_found", "跟进事项不存在");
    await this.authorize(actor, "proposal.submit", item.workspaceSlug);
    const summaryUpdatedAt = await this.store.getSummaryUpdatedAt(item.summaryId);
    if (item.version !== body.followUpVersion || !item.sourceAvailable || item.sourceFreshness !== "fresh" || summaryUpdatedAt !== body.summaryUpdatedAt || item.sourceUpdatedAt !== body.summaryUpdatedAt || item.status === "resolved" || item.status === "dismissed") {
      throw new OpsProposalServiceError("conflict", "建议前提已变化");
    }
    const inputSummary = JSON.stringify({ action: body.action.type, followUpId: item.followUpId, followUpVersion: item.version, summaryId: item.summaryId, summaryUpdatedAt: item.sourceUpdatedAt });
    try { return await this.store.create({ ...body, inputSummary, summaryId: item.summaryId, actorSubject: actor.subject, agentId: actor.agentId ?? null, requestDigest }); }
    catch (error) {
      const concurrent = await this.replay(actor, body.idempotencyKey, requestDigest);
      if (concurrent) {
        await this.authorize(actor, "proposal.submit", item.workspaceSlug);
        return concurrent;
      }
      const current = await this.store.getFollowUp(body.followUpId);
      if (!current || current.version !== body.followUpVersion || current.sourceUpdatedAt !== body.summaryUpdatedAt || !current.sourceAvailable) throw new OpsProposalServiceError("conflict", "建议前提已变化");
      throw error;
    }
  }

  async review(actor: OpsProposalActor, input: { proposalId: string; expectedVersion: number; actionDigest: string; decision: "approve" | "reject"; reason: string; idempotencyKey: string }): Promise<OpsProposal> {
    requireCapability(actor, "activation.proposal.review");
    requireCapability(actor, "activation.proposal.read");
    requireCapability(actor, "activation.followup.read");
    if (actor.kind !== "human" || actor.agentId) throw new OpsProposalServiceError("capability_missing", "建议必须由真人审阅");
    const parsed = reviewOpsProposalSchema.safeParse({ expectedVersion: input.expectedVersion, actionDigest: input.actionDigest, decision: input.decision, reason: input.reason, idempotencyKey: input.idempotencyKey });
    if (!input.proposalId.startsWith("ops_proposal:") || !parsed.success) throw new OpsProposalServiceError("invalid_request", "审阅请求无效");
    const requestDigest = digest({ event: "review", input });
    const replay = await this.replay(actor, input.idempotencyKey, requestDigest);
    if (replay) return replay;
    const proposal = await this.get(actor, input.proposalId);
    if (proposal.status !== "pending" || proposal.version !== input.expectedVersion || this.actionDigest(proposal.action) !== input.actionDigest) throw new OpsProposalServiceError("conflict", "建议版本或动作已变化");
    if (proposal.agentId && proposal.proposerSubject === actor.subject) throw new OpsProposalServiceError("capability_missing", "agent 建议须由其他真人审阅");
    if (input.decision === "approve") await this.assertCurrent(proposal);
    let result: OpsProposal | null;
    try { result = await this.store.review({ ...input, actorSubject: actor.subject, agentId: null, requestDigest }); }
    catch (error) {
      if (input.decision === "approve") await this.assertCurrent(proposal);
      throw error;
    }
    if (!result) throw new OpsProposalServiceError("conflict", "建议已由其他人审阅");
    return result;
  }

  private async assertCurrent(proposal: OpsProposal): Promise<void> {
    const [item, summaryUpdatedAt] = await Promise.all([this.store.getFollowUp(proposal.followUpId), this.store.getSummaryUpdatedAt(proposal.summaryId)]);
    if (!item || item.version !== proposal.followUpVersion || item.sourceUpdatedAt !== proposal.summaryUpdatedAt || !item.sourceAvailable || item.sourceFreshness !== "fresh" || summaryUpdatedAt !== proposal.summaryUpdatedAt || item.status === "resolved" || item.status === "dismissed") {
      throw new OpsProposalServiceError("conflict", "建议前提已变化，旧批准无效");
    }
  }

  async execute(actor: OpsProposalActor, input: { proposalId: string; expectedVersion: number; idempotencyKey: string }): Promise<OpsProposal> {
    requireCapability(actor, "activation.proposal.execute");
    requireCapability(actor, "activation.proposal.read");
    requireCapability(actor, "activation.followup.read");
    requireCapability(actor, "activation.followup.write");
    if (!executeOpsProposalSchema.safeParse({ expectedVersion: input.expectedVersion, idempotencyKey: input.idempotencyKey }).success) throw new OpsProposalServiceError("invalid_request", "执行请求无效");
    const requestDigest = digest({ event: "execute", input });
    const replay = await this.replay(actor, input.idempotencyKey, requestDigest);
    if (replay) {
      const priorFollowUp = await this.store.getFollowUp(replay.followUpId);
      if (!priorFollowUp) throw new OpsProposalServiceError("not_found", "跟进事项不存在");
      await this.authorize(actor, "proposal.execute", priorFollowUp.workspaceSlug);
      return replay;
    }
    let proposal = await this.get(actor, input.proposalId);
    const followUp = await this.store.getFollowUp(proposal.followUpId);
    if (!followUp) throw new OpsProposalServiceError("not_found", "跟进事项不存在");
    await this.authorize(actor, "proposal.execute", followUp.workspaceSlug);
    if (proposal.version !== input.expectedVersion || (proposal.status !== "approved" && proposal.status !== "executing")) throw new OpsProposalServiceError("conflict", "建议未获有效批准");
    if (proposal.status === "executing" && proposal.executorSubject !== actor.subject) throw new OpsProposalServiceError("conflict", "建议正由另一执行人处理");
    const actionKey = `proposal-action-${digest(proposal.proposalId).slice(0, 48)}`;
    const alreadyApplied = await this.store.findAppliedAction(actor.subject, actionKey, proposal.followUpId);
    if (!alreadyApplied) {
      try { await this.assertCurrent(proposal); }
      catch (error) {
        if (!(error instanceof OpsProposalServiceError) || error.code !== "conflict") throw error;
        const stale = await this.store.finish({ proposalId: proposal.proposalId, expectedVersion: proposal.version, status: "stale",
          toolResult: { code: "premise_changed" }, actionFollowUpVersion: null, actorSubject: actor.subject,
          agentId: actor.agentId ?? null, idempotencyKey: input.idempotencyKey, requestDigest });
        if (!stale) throw new OpsProposalServiceError("conflict", "建议执行状态已变化");
        return stale;
      }
    }
    if (proposal.status === "approved") {
      const reserved = await this.store.reserve({ proposalId: proposal.proposalId, expectedVersion: proposal.version,
        actorSubject: actor.subject, agentId: actor.agentId ?? null, idempotencyKey: `start-${input.idempotencyKey}`,
        requestDigest: digest({ event: "execution_started", proposalId: proposal.proposalId, actorSubject: actor.subject }) });
      if (!reserved) throw new OpsProposalServiceError("conflict", "建议已由另一执行人接手");
      proposal = reserved;
    }
    let status: "succeeded" | "failed" | "stale" = "succeeded";
    let toolResult: NonNullable<OpsProposal["toolResult"]>;
    let actionFollowUpVersion: number | null = null;
    try {
      const item = alreadyApplied ? null : proposal.action.type === "follow_up.claim"
        ? await this.actions.claim(actor, { followUpId: proposal.followUpId, expectedVersion: proposal.followUpVersion, leaseSeconds: proposal.action.leaseSeconds, idempotencyKey: actionKey, sourceSummaryId: proposal.summaryId, sourceUpdatedAt: proposal.summaryUpdatedAt })
        : await this.actions.update(actor, { followUpId: proposal.followUpId, expectedVersion: proposal.followUpVersion, status: proposal.action.status, dueCheckAt: proposal.action.dueCheckAt, result: proposal.action.result, idempotencyKey: actionKey, sourceSummaryId: proposal.summaryId, sourceUpdatedAt: proposal.summaryUpdatedAt });
      actionFollowUpVersion = alreadyApplied?.followUpVersion ?? item!.version;
      toolResult = { code: "action_succeeded", followUpId: proposal.followUpId, followUpVersion: actionFollowUpVersion };
    } catch {
      const appliedAfterError = await this.store.findAppliedAction(actor.subject, actionKey, proposal.followUpId);
      if (appliedAfterError) {
        actionFollowUpVersion = appliedAfterError.followUpVersion;
        toolResult = { code: "action_succeeded", followUpId: proposal.followUpId, followUpVersion: actionFollowUpVersion };
      } else {
        try {
          await this.assertCurrent(proposal);
          status = "failed";
          toolResult = { code: "action_failed" };
        } catch (error) {
          if (!(error instanceof OpsProposalServiceError) || error.code !== "conflict") throw error;
          status = "stale";
          toolResult = { code: "premise_changed" };
        }
      }
    }
    const finished = await this.store.finish({ proposalId: proposal.proposalId, expectedVersion: proposal.version, status, toolResult, actionFollowUpVersion, actorSubject: actor.subject, agentId: actor.agentId ?? null, idempotencyKey: input.idempotencyKey, requestDigest });
    if (!finished) throw new OpsProposalServiceError("conflict", "建议执行状态已变化");
    return finished;
  }

  async takeover(actor: OpsProposalActor, input: { followUpId: string; expectedVersion: number; leaseSeconds: number; reason: string; idempotencyKey: string }): Promise<FollowUpItem> {
    requireCapability(actor, "activation.proposal.takeover");
    requireCapability(actor, "activation.followup.read");
    requireCapability(actor, "activation.followup.write");
    if (actor.kind !== "human" || actor.agentId) throw new OpsProposalServiceError("capability_missing", "仅真人可接管事项");
    const parsed = takeoverFollowUpSchema.safeParse({ expectedVersion: input.expectedVersion, leaseSeconds: input.leaseSeconds, reason: input.reason, idempotencyKey: input.idempotencyKey });
    if (!input.followUpId.startsWith("activation_follow_up:") || !parsed.success) throw new OpsProposalServiceError("invalid_request", "接管请求无效");
    const requestDigest = digest({ event: "takeover", input });
    const replay = await this.store.findTakeoverIdempotency(actor.subject, input.idempotencyKey);
    if (replay) {
      if (replay.requestDigest !== requestDigest) throw new OpsProposalServiceError("conflict", "幂等键已用于不同接管请求");
      return replay.item;
    }
    const now = Date.now();
    let changed: FollowUpItem | null;
    try {
      changed = await this.store.takeover({ followUpId: input.followUpId, expectedVersion: input.expectedVersion,
        leaseExpiresAt: new Date(now + input.leaseSeconds * 1000).toISOString(), reason: input.reason,
        actorSubject: actor.subject, idempotencyKey: input.idempotencyKey, requestDigest });
    } catch (error) {
      const concurrent = await this.store.findTakeoverIdempotency(actor.subject, input.idempotencyKey);
      if (concurrent?.requestDigest === requestDigest) return concurrent.item;
      throw error;
    }
    if (!changed) throw new OpsProposalServiceError("conflict", "事项版本已变化或不能接管");
    return changed;
  }
}
