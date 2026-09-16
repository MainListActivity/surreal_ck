import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { handleError } from "../middleware/error";
import { createSyntheticJudgmentBatch } from "@surreal-ck/shared/platform-content";
import { InMemoryPlatformContentStore, PlatformContentService } from "../content/service";
import { createContentRoutes } from "./content";
import { createLegalContentRoutes } from "./legal-content";

const source = {
  sourceKey: "fixture.synthetic.cn",
  label: "fixture",
  status: "active" as const,
  allowedActions: ["submit", "publish", "withdraw", "restore"] as const,
};

const operator = {
  subject: "operator:test",
  capabilities: ["content.read", "content.submit", "content.publish", "content.withdraw", "content.restore", "content.source.manage"] as const,
};

function useOperator(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    c.set("user", { subject: operator.subject, email: "operator@example.test", raw: {}, rawToken: "test" });
    c.set("platformOperator", operator);
    await next();
  };
}

describe("platform content routes", () => {
  test("ordinary authenticated users can search published legal content without operator capabilities", async () => {
    const store = new InMemoryPlatformContentStore();
    const service = new PlatformContentService({ store, sources: [source], idFactory: (prefix) => `${prefix}_public` });
    const batch = await createSyntheticJudgmentBatch();
    const submitted = await service.submitBatch(operator, batch);
    await service.publishBatch(operator, {
      batchId: submitted.batchId,
      validationRevision: 1,
      entryKeys: ["fixture-judgment-1"],
      idempotencyKey: "public-search-publication",
    });
    const app = new Hono<AppBindings>();
    app.onError(handleError);
    app.route("/", createLegalContentRoutes({
      service,
      requireUser: () => async (c, next) => {
        c.set("user", { subject: "user:reader", email: "reader@example.test", raw: {}, rawToken: "test" });
        await next();
      },
    }));

    const response = await app.request("/api/legal/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "合成全文", limit: 5 }),
    });

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.items).toHaveLength(1);
    expect(result.items[0].version.publicationStatus).toBe("published");
  });

  test("exposes the five contract operations behind the operator context", async () => {
    const service = new PlatformContentService({ store: new InMemoryPlatformContentStore(), sources: [source] });
    const app = new Hono<AppBindings>();
    app.onError(handleError);
    app.route("/", createContentRoutes({ service, requireUser: () => useOperator() }));
    const contract = await app.request("/api/content/contract");
    expect(contract.status).toBe(200);
    expect((await contract.json()).operations).toHaveLength(5);
    const batch = await createSyntheticJudgmentBatch();
    const submitted = await app.request("/api/content/batches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(batch),
    });
    expect(submitted.status).toBe(200);
    expect((await submitted.json()).status).toBe("ready");
  });

  test("does not expose content routes without a platform operator", async () => {
    const service = new PlatformContentService({ store: new InMemoryPlatformContentStore(), sources: [source] });
    const app = new Hono<AppBindings>();
    app.onError(handleError);
    app.route("/", createContentRoutes({ service, requireUser: () => async (_c, next) => next() }));
    const response = await app.request("/api/content/contract");
    expect(response.status).toBe(403);
  });

  test("supports source registration, batch summaries, details, and audit pagination", async () => {
    const service = new PlatformContentService({ store: new InMemoryPlatformContentStore(), sources: [source] });
    const app = new Hono<AppBindings>();
    app.onError(handleError);
    app.route("/", createContentRoutes({ service, requireUser: () => useOperator() }));

    const sourceResponse = await app.request("/api/content/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceKey: "gov.example.cn",
        label: "公开法规示例",
        jurisdiction: "中国大陆",
        baseUrl: "https://gov.example.cn",
        status: "active",
        allowedActions: ["submit", "publish"],
        license: {
          licenseKind: "public",
          allowedActions: ["submit", "publish"],
          effectiveFrom: "2026-09-01T00:00:00Z",
          evidenceUrl: "https://gov.example.cn/license",
          evidenceText: "公开许可说明",
        },
      }),
    });
    expect(sourceResponse.status).toBe(200);
    expect((await sourceResponse.json()).license.revision).toBe(1);

    const batch = await createSyntheticJudgmentBatch();
    const submitted = await app.request("/api/content/batches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(batch),
    });
    const batchBody = await submitted.json() as { batchId: string };
    const summaries = await app.request("/api/content/batches?limit=1");
    expect(summaries.status).toBe(200);
    expect((await summaries.json()).items[0].batchId).toBe(batchBody.batchId);
    const detail = await app.request(`/api/content/batches/${encodeURIComponent(batchBody.batchId)}/detail`);
    expect(detail.status).toBe(200);
    expect((await detail.json()).summary.entryCount).toBe(1);
    const audit = await app.request(`/api/content/audit?batchId=${encodeURIComponent(batchBody.batchId)}`);
    expect(audit.status).toBe(200);
    expect((await audit.json()).items[0].batchId).toBe(batchBody.batchId);
  });
});
