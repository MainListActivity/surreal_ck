import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { handleError } from "../middleware/error";
import { ActivationSummaryService } from "../activation-summary/service";
import { createActivationSummaryRoutes } from "./activation-summary";
import type { ActivationSummaryV1, SharedActivationSummary } from "@surreal-ck/shared";

const summary: ActivationSummaryV1 = {
  contractVersion: "1",
  period: { startedAt: "2026-09-01T00:00:00.000Z", endedAt: "2026-10-01T00:00:00.000Z", timeZone: "UTC" },
  stage: "incomplete",
  metrics: {
    members: { state: "completed", count: 1, source: "workspace.user" },
    workbooks: { state: "incomplete", count: 0, source: "workspace.workbook" },
    imports: { state: "unknown", count: null, source: "not_reported_v1" },
    reviews: { state: "unknown", count: null, source: "not_reported_v1" },
  },
  updatedAt: "2026-09-22T12:00:00.000Z",
  dedupeKey: "2026-09:v1",
};

function makeApp(scope = "activation.summary.read") {
  let item: SharedActivationSummary | null = null;
  const service = new ActivationSummaryService({
    async resolveAdmin(slug, subject) {
      return slug === "demo" && subject === "admin-1"
        ? { workspaceId: "workspace:demo", workspaceSlug: slug, dbName: "ws_demo" }
        : null;
    },
    async findIdempotent() { return null; },
    async share(input) {
      item = { summaryId: "workspace_activation_summary:demo", workspaceSlug: "demo", contractVersion: "1", status: "active", summary: input.summary, suppliedAt: input.summary.updatedAt, updatedAt: input.summary.updatedAt, sourceTrust: "team_supplied" };
      return item;
    },
    async withdraw() {
      item = { ...(item as SharedActivationSummary), status: "withdrawn", summary: null, suppliedAt: null };
      return item;
    },
    async list() { return item?.status === "active" ? [item] : []; },
    async get() { return item; },
  });
  const user: MiddlewareHandler<AppBindings> = async (c, next) => {
    c.set("user", { subject: "admin-1", raw: {}, rawToken: "token" });
    await next();
  };
  const ops: MiddlewareHandler<AppBindings> = async (c, next) => {
    c.set("user", { subject: "ops-1", raw: { scope }, rawToken: "ops-token" });
    c.set("platformOperator", { subject: "ops-1", capabilities: ["activation.summary.read"] });
    await next();
  };
  const app = new Hono<AppBindings>();
  app.onError(handleError);
  app.route("/", createActivationSummaryRoutes({ service, requireUser: () => user, requireOperator: () => ops }));
  return app;
}

describe("activation summary routes", () => {
  test("customer share and operator page read the same service projection", async () => {
    const app = makeApp();
    const shared = await app.request("/api/workspaces/demo/activation-summary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ summary, idempotencyKey: "request-0001" }),
    });
    expect(shared.status).toBe(200);
    const page = await app.request("/api/ops/activation-summaries?limit=20");
    expect(page.status).toBe(200);
    expect((await page.json()).items[0]).toMatchObject({ workspaceSlug: "demo", sourceTrust: "team_supplied" });
  });

  test("token scope narrows a currently granted capability", async () => {
    const app = makeApp("content.read");
    const response = await app.request("/api/ops/activation-summaries");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "activation-summary-capability_missing" } });
  });

  test("withdrawal clears and hides the summary", async () => {
    const app = makeApp();
    await app.request("/api/workspaces/demo/activation-summary", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ summary, idempotencyKey: "request-0001" }),
    });
    const withdrawn = await app.request("/api/workspaces/demo/activation-summary", {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: "withdraw-0001" }),
    });
    expect((await withdrawn.json()).summary).toBeNull();
    const page = await app.request("/api/ops/activation-summaries");
    expect((await page.json()).items).toEqual([]);
  });
});
