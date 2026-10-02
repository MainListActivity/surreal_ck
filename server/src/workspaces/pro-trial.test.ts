import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ProTrialService, type TrialClaim, type TrialStore } from "./pro-trial";
import type { CreateWorkspaceInput, CreateWorkspaceResult } from "./create-workspace";
import { createProTrialRoutes } from "../routes/pro-trial";
import { HttpError } from "../http-error";
import type { AppBindings } from "../hono-types";

const claim: TrialClaim = { id: "pro_trial_claim:test", accountId: "billing_account:test", subject: "owner", slug: "synthetic", name: "Synthetic",
  startedAt: "2026-10-01T12:00:00.000Z", endsAt: "2026-10-08T12:00:00.000Z", state: "provisioning",
  offer: { revision: "pro_trial_revision:test", productRevision: "product_plan_revision:test", resourceRevision: "quota_plan_revision:test",
    resourcePlanKey: "trial", collections: [{ key: "synthetic", label: "合成不可售" }], allowance: 10, researchRate: 2, rateRevision: 2,
    capacity: [{ label: "自建数据表", limit: 2 }], reminderHours: [24], fixture: true } };
const input = { subject: "owner", subjectToken: "local-fixture", email: "local@example.invalid", accountKey: "test", name: "Synthetic", slug: "synthetic", key: "repeat", offerRevision: claim.offer.revision };
function harness(result: CreateWorkspaceResult, acquired: { claim: TrialClaim; lease: string | null } = { claim, lease: "lease" }) {
  const calls: CreateWorkspaceInput[] = [];
  const finishes: boolean[] = [];
  const store: TrialStore = { accounts: async () => [{ key: "test", name: "Synthetic" }], offer: async () => claim.offer,
    claim: async () => acquired, status: async () => null, finish: async (_claim, _lease, success) => { finishes.push(success); } };
  const service = new ProTrialService(store, { createWorkspace: async request => { calls.push(request); return result; } }, () => new Date("2026-10-01T12:00:00Z"));
  return { calls, finishes, service };
}
describe("explicit Pro trial service", () => {
  test("preview is server-clocked, seven UTC days, no creation or grant", async () => {
    const h = harness({ kind: "slug-conflict" });
    expect(await h.service.preview("owner", "test")).toMatchObject({ durationDays: 7, timezone: "UTC", endsAt: claim.endsAt, fixture: true, researchRate: 2 });
    expect(h.calls).toHaveLength(0); expect(h.finishes).toHaveLength(0);
  });
  test("creator receives pinned server context, not customer-selected product or duration", async () => {
    const h = harness({ kind: "scope-update-failed", slug: claim.slug, dbName: "ws_test" });
    expect(await h.service.start(input)).toMatchObject({ state: "active", endsAt: claim.endsAt });
    expect(h.calls[0]?.resourceSource.trial).toMatchObject({ billingAccountId: claim.accountId, startsAt: claim.startedAt, endsAt: claim.endsAt, productRevisionId: claim.offer.productRevision });
    expect(h.finishes).toEqual([true]);
  });
  test("failed delivery releases only execution lease; no active declaration", async () => {
    const h = harness({ kind: "provisioning_error", code: "content-not-ready", message: "synthetic", slug: claim.slug, dbName: "ws_test" });
    await expect(h.service.start(input)).rejects.toMatchObject({ status: 503 });
    expect(h.finishes).toEqual([false]);
  });
  test("already-active replay never provisions or grants again", async () => {
    const h = harness({ kind: "slug-conflict" }, { claim: { ...claim, state: "active" }, lease: null });
    expect(await h.service.start(input)).toMatchObject({ state: "active" });
    expect(h.calls).toHaveLength(0); expect(h.finishes).toHaveLength(0);
  });
  test("in-flight replay is pending, never starts another creator", async () => {
    const h = harness({ kind: "slug-conflict" }, { claim, lease: null });
    await expect(h.service.start(input)).rejects.toMatchObject({ status: 409 });
    expect(h.calls).toHaveLength(0);
  });
  test("HTTP rejects injected security/plan/time authority", async () => {
    const h = harness({ kind: "scope-update-failed", slug: claim.slug, dbName: "ws_test" });
    const app = new Hono<AppBindings>();
    app.onError((e, c) => c.json({ error: e.message }, e instanceof HttpError ? e.status : 500));
    app.route("/", createProTrialRoutes(h.service, () => async (c, next) => { c.set("user", { subject: "owner", rawToken: "local-fixture", raw: {} }); await next(); }));
    for (const injection of [{ productRevision: "product_plan_revision:max" }, { durationDays: 999 }, { subject: "other" }, { resourceSource: { sourceKind: "paid" } }]) {
      const response = await app.request("/api/pro-trial/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountKey: "test", slug: "synthetic", name: "Synthetic", key: "repeat", offerRevision: claim.offer.revision, ...injection }) });
      expect(response.status).toBe(400);
    }
    expect(h.calls).toHaveLength(0);
  });
});
