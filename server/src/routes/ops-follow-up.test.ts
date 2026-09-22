import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppBindings } from "../hono-types";
import { handleError } from "../middleware/error";
import { OpsFollowUpService, type OpsFollowUpStore } from "../ops-follow-up/service";
import { createOpsFollowUpRoutes } from "./ops-follow-up";
import type { ActivationSummaryV1, FollowUpItem, SharedActivationSummary } from "@surreal-ck/shared";

const content: ActivationSummaryV1 = {
  contractVersion: "1",
  period: { startedAt: "2026-09-01T00:00:00.000Z", endedAt: "2026-10-01T00:00:00.000Z", timeZone: "UTC" },
  stage: "incomplete",
  metrics: {
    members: { state: "completed", count: 1, source: "user" },
    workbooks: { state: "incomplete", count: 0, source: "workbook" },
    imports: { state: "unknown", count: null, source: "import" },
    reviews: { state: "unknown", count: null, source: "review" },
  },
  updatedAt: "2026-09-22T12:00:00.000Z",
  dedupeKey: "period-v1",
};
const source: SharedActivationSummary = { summaryId: "workspace_activation_summary:demo", workspaceSlug: "demo", contractVersion: "1", status: "active", summary: content, suppliedAt: content.updatedAt, updatedAt: content.updatedAt, sourceTrust: "team_supplied" };

function appWithScope(scope: string) {
  let item: FollowUpItem | null = null;
  const store: OpsFollowUpStore = {
    async listActiveSummaries() { return [source]; },
    async getSummary() { return source; },
    async findIdempotent() { return null; },
    async create(input) {
      item = { followUpId: "activation_follow_up:one", workspaceSlug: input.workspaceSlug, summaryId: input.summaryId, reason: input.reason, period: input.period, dedupeKey: input.dedupeKey, sourceContractVersion: input.sourceContractVersion, sourceUpdatedAt: input.sourceUpdatedAt, sourceAvailable: true, sourceFreshness: "fresh", status: "open", ownerSubject: null, leaseExpiresAt: null, dueCheckAt: input.dueCheckAt, result: null, version: 1, createdAt: content.updatedAt, updatedAt: content.updatedAt, nextStep: "claim" };
      return item;
    },
    async list() { return item ? [item] : []; },
    async get() { return item; },
    async claim(input) { item = item ? { ...item, status: "claimed", ownerSubject: input.actorSubject, leaseExpiresAt: input.leaseExpiresAt, version: 2, nextStep: "update" } : null; return item; },
    async update(input) { item = item ? { ...item, status: input.status, dueCheckAt: input.dueCheckAt, result: input.result, version: 3, nextStep: "none" } : null; return item; },
  };
  const app = new Hono<AppBindings>();
  app.onError(handleError);
  app.route("/", createOpsFollowUpRoutes({
    service: new OpsFollowUpService(store, () => new Date(content.updatedAt)),
    requireOperator: () => async (c, next) => {
      c.set("user", { subject: "ops-a", rawToken: "token", raw: { scope } });
      c.set("platformOperator", { subject: "ops-a", capabilities: ["activation.followup.read", "activation.followup.write"] });
      await next();
    },
  }));
  return app;
}

describe("ops follow-up routes", () => {
  test("narrows platform capabilities by OAuth scope", async () => {
    const response = await appWithScope("activation.summary.read").request("/api/ops/activation-opportunities");
    expect(response.status).toBe(403);
  });

  test("supports opportunity, create, claim, list and update through one contract", async () => {
    const app = appWithScope("activation.followup.read activation.followup.write");
    const opportunities = await app.request("/api/ops/activation-opportunities");
    expect(opportunities.status).toBe(200);
    const opportunityId = ((await opportunities.json()) as { items: Array<{ opportunityId: string }> }).items[0]!.opportunityId;
    const created = await app.request("/api/ops/follow-ups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ opportunityId, dueCheckAt: null, idempotencyKey: "create-route-0001" }) });
    expect(created.status).toBe(201);
    const claimed = await app.request("/api/ops/follow-ups/activation_follow_up:one/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: 1, leaseSeconds: 60, idempotencyKey: "claim-route-0001" }) });
    expect(claimed.status).toBe(200);
    const updated = await app.request("/api/ops/follow-ups/activation_follow_up:one", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: 2, status: "resolved", dueCheckAt: null, result: "handled", idempotencyKey: "update-route-0001" }) });
    expect(updated.status).toBe(200);
    const queue = await app.request("/api/ops/follow-ups");
    expect(((await queue.json()) as { items: FollowUpItem[] }).items[0]).toMatchObject({ status: "resolved", result: "handled" });
  });
});
