import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { handleError } from "../middleware/error";
import { createOpsProposalRoutes } from "./ops-proposal";
import { createContentMcpRoutes } from "../ops/mcp/routes";
import { InMemoryPlatformContentStore, PlatformContentService } from "../content/service";
import { OpsProposalService, type OpsProposalStore } from "../ops-proposal/service";
import type { FollowUpItem, OpsProposal } from "@surreal-ck/shared";

const now = "2026-09-22T12:00:00.000Z";
function fixture(scope: string) {
  const item: FollowUpItem = { followUpId: "activation_follow_up:one", workspaceSlug: "demo", summaryId: "workspace_activation_summary:one", reason: "activation_incomplete",
    period: { startedAt: now, endedAt: now, timeZone: "UTC" }, dedupeKey: "one", sourceContractVersion: "2", sourceUpdatedAt: now,
    sourceAvailable: true, sourceFreshness: "fresh", status: "open", ownerSubject: null, leaseExpiresAt: null,
    dueCheckAt: null, result: null, version: 1, createdAt: now, updatedAt: now, nextStep: "claim" };
  let proposal: OpsProposal | null = null;
  const store: OpsProposalStore = {
    async getFollowUp() { return item; }, async getSummaryUpdatedAt() { return now; }, async findByIdempotency() { return null; },
    async get() { return proposal; }, async list() { return proposal ? [proposal] : []; },
    async create(input) { proposal = { proposalId: "ops_proposal:one", followUpId: input.followUpId, summaryId: input.summaryId,
      summaryUpdatedAt: input.summaryUpdatedAt, followUpVersion: input.followUpVersion, action: input.action,
      actionDigest: service.actionDigest(input.action), rationale: input.rationale, expectedResult: input.expectedResult,
      triggerReason: input.triggerReason, inputSummary: input.inputSummary, proposerSubject: input.actorSubject, agentId: input.agentId,
      status: "pending", version: 1, executorSubject: null, reviewerSubject: null, reviewReason: null, toolResult: null, actionFollowUpVersion: null,
      createdAt: now, updatedAt: now }; return proposal; },
    async review(input) { if (!proposal) return null; proposal = { ...proposal, status: input.decision === "approve" ? "approved" : "rejected", version: proposal.version + 1, reviewerSubject: input.actorSubject, reviewReason: input.reason }; return proposal; },
    async reserve(input) { if (!proposal || proposal.status !== "approved") return null; proposal = { ...proposal, status: "executing", executorSubject: input.actorSubject, version: proposal.version + 1 }; return proposal; },
    async finish(input) { if (!proposal) return null; proposal = { ...proposal, status: input.status, version: proposal.version + 1, toolResult: input.toolResult, actionFollowUpVersion: input.actionFollowUpVersion }; return proposal; },
    async takeover() { return item; }, async findTakeoverIdempotency() { return null; }, async findAppliedAction() { return null; },
  };
  const service = new OpsProposalService(store, { claim: async () => ({ ...item, version: 2, status: "claimed" }), update: async () => item });
  const authorize = (): MiddlewareHandler<AppBindings> => async (c, next) => {
    c.set("user", { subject: "ops-human", rawToken: "token", raw: { scope } });
    c.set("platformOperator", { subject: "ops-human", kind: "human", capabilities: ["activation.proposal.read", "activation.proposal.submit", "activation.proposal.review", "activation.proposal.execute", "activation.followup.read", "activation.followup.write"] });
    await next();
  };
  const app = new Hono<AppBindings>();
  app.onError(handleError);
  app.route("/", createOpsProposalRoutes({ service, requireOperator: authorize }));
  app.route("/", createContentMcpRoutes({ service: new PlatformContentService({ store: new InMemoryPlatformContentStore(), sources: [] }), opsProposalService: service, requireOperator: authorize() }));
  return app;
}
async function mcp(app: Hono<AppBindings>, name: string, args: object) {
  const response = await app.request("/api/ops/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return (await response.json() as { result?: { structuredContent?: unknown } }).result?.structuredContent;
}

describe("ops proposal HTTP and MCP", () => {
  test("页面与 MCP 读取同一建议状态，OAuth scope 收窄", async () => {
    const app = fixture("activation.proposal.read activation.proposal.submit activation.proposal.review activation.proposal.execute activation.followup.read activation.followup.write");
    const body = { followUpId: "activation_follow_up:one", followUpVersion: 1, summaryUpdatedAt: now,
      action: { type: "follow_up.claim", leaseSeconds: 900 }, rationale: "启用未完成", expectedResult: "内部事项认领",
      triggerReason: "fresh_activation_opportunity", inputSummary: "启用摘要未完成", idempotencyKey: "proposal-route-0001" };
    const createdResponse = await app.request("/api/ops/proposals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as OpsProposal;
    const fromMcp = await mcp(app, "get_ops_proposal", { proposalId: created.proposalId });
    expect(fromMcp).toEqual(created);
    const approved = await mcp(app, "review_ops_proposal", { proposalId: created.proposalId, expectedVersion: 1, actionDigest: created.actionDigest, decision: "approve", reason: "同意", idempotencyKey: "proposal-mcp-review-0001" }) as OpsProposal;
    const fromHttp = await app.request(`/api/ops/proposals/${created.proposalId}`);
    expect(await fromHttp.json()).toEqual(approved);
  });
  test("仅有 read scope 不能经页面或 MCP 提交", async () => {
    const app = fixture("activation.proposal.read");
    const body = { followUpId: "activation_follow_up:one", followUpVersion: 1, summaryUpdatedAt: now,
      action: { type: "follow_up.claim", leaseSeconds: 900 }, rationale: "启用未完成", expectedResult: "内部事项认领",
      triggerReason: "fresh_activation_opportunity", inputSummary: "启用摘要未完成", idempotencyKey: "proposal-denied-0001" };
    const response = await app.request("/api/ops/proposals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(403);
    const denied = await mcp(app, "submit_ops_proposal", body) as { error?: { code?: string } };
    expect(denied.error?.code).toBe("capability_missing");
  });
});
