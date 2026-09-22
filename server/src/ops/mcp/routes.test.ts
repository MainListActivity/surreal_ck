import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../../hono-types";
import { handleError } from "../../middleware/error";
import { HttpError } from "../../http-error";
import { createSyntheticJudgmentBatch } from "@surreal-ck/shared/platform-content";
import {
  InMemoryPlatformContentStore,
  PlatformContentService,
  type ContentSourceRegistration,
} from "../../content/service";
import { createContentMcpRoutes } from "./routes";
import { ActivationSummaryService } from "../../activation-summary/service";
import type { ActivationSummaryV1, FollowUpItem, SharedActivationSummary } from "@surreal-ck/shared";
import { OpsFollowUpService } from "../../ops-follow-up/service";

const source: ContentSourceRegistration = {
  sourceKey: "official-demo",
  label: "官方演示来源",
  status: "active",
  allowedActions: ["submit", "publish", "withdraw", "restore"],
};

function createTestApp(
  middleware: MiddlewareHandler<AppBindings> = async (c, next) => {
    c.set("platformOperator", {
      subject: "operator:ada",
      capabilities: [
        "content.read",
        "content.submit",
        "content.publish",
        "content.withdraw",
        "content.restore",
      ],
    });
    await next();
  },
  resourceUri?: string,
) {
  const service = new PlatformContentService({
    store: new InMemoryPlatformContentStore(),
    sources: [source],
  });
  const app = new Hono<AppBindings>();
  app.onError(handleError);
  app.route(
    "/",
    createContentMcpRoutes({
      service,
      authorizationServer: "https://auth.example.test",
      resourceUri,
      requireOperator: middleware,
    }),
  );
  return app;
}

async function call(app: Hono<AppBindings>, body: Record<string, unknown>) {
  return await app.fetch(
    new Request("https://api.example.test/api/ops/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer test-token",
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("platform content MCP", () => {
  test("publishes protected-resource metadata and returns a bearer discovery challenge", async () => {
    const app = createTestApp(async () => {
      throw new HttpError(401, "oidc-missing", "Missing bearer token");
    }, "https://auth.example.test/ops");
    const metadata = await app.fetch(
      new Request("https://api.example.test/api/ops/.well-known/oauth-protected-resource"),
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toEqual({
      resource: "https://auth.example.test/ops",
      authorization_servers: ["https://auth.example.test"],
      scopes_supported: [
        "content.read",
        "content.submit",
        "content.publish",
        "content.withdraw",
        "content.restore",
        "content.source.manage",
        "activation.summary.read",
        "activation.followup.read",
        "activation.followup.write",
      ],
      bearer_methods_supported: ["header"],
    });

    const response = await app.fetch(
      new Request("https://api.example.test/api/ops/mcp", { method: "POST" }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://api.example.test/api/ops/.well-known/oauth-protected-resource"',
    );
  });

  test("derives the MCP resource URL when no audience override is provided", async () => {
    const app = createTestApp();
    const metadata = await app.fetch(
      new Request("https://api.example.test/api/ops/.well-known/oauth-protected-resource"),
    );
    expect(metadata.status).toBe(200);
    expect((await metadata.json()).resource).toBe("https://api.example.test/api/ops/mcp");
  });

  test("uses the public forwarded origin in the discovery challenge", async () => {
    const app = createTestApp(async () => {
      throw new HttpError(401, "oidc-missing", "Missing bearer token");
    });
    const response = await app.fetch(
      new Request("https://data.example.test/api/ops/mcp", {
        method: "POST",
        headers: {
          "x-surreal-ck-public-host": "l.example.test",
          "x-surreal-ck-public-proto": "https",
        },
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://l.example.test/api/ops/.well-known/oauth-protected-resource"',
    );
  });

  test("serves initialize, tools/list, and structured business errors through Streamable HTTP", async () => {
    const app = createTestApp();
    const initialize = await call(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });
    expect(initialize.status).toBe(200);
    const initializeBody = (await initialize.json()) as {
      result?: { serverInfo?: { name?: string } };
    };
    expect(initializeBody.result?.serverInfo?.name).toBe("surreal-ck-platform-content");

    const tools = await call(app, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect(tools.status).toBe(200);
    const toolsBody = (await tools.json()) as { result?: { tools?: Array<{ name: string }> } };
    expect(toolsBody.result?.tools?.map((tool) => tool.name)).toEqual([
      "get_data_contract",
      "search_content",
      "submit_batch",
      "inspect_batch",
      "publish_batch",
    ]);

    const invalidCall = await call(app, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "inspect_batch", arguments: {} },
    });
    expect(invalidCall.status).toBe(200);
    const invalidBody = (await invalidCall.json()) as {
      result?: { isError?: boolean; structuredContent?: { error?: { code?: string } } };
    };
    expect(invalidBody.result?.isError).toBe(true);
    expect(invalidBody.result?.structuredContent?.error?.code).toBe("invalid_request");
  });

  test("uses the shared service pagination and idempotency path for MCP calls", async () => {
    const app = createTestApp();
    const fixture = await createSyntheticJudgmentBatch();
    const batch = {
      ...fixture,
      idempotencyKey: "mcp-pagination",
      items: Array.from({ length: 2 }, (_, index) => ({
        ...fixture.items[0]!,
        entryKey: `mcp-entry-${index + 1}`,
        payload: { ...fixture.items[0]!.payload, source: { ...fixture.items[0]!.payload.source, recordKey: null } },
      })),
    };
    const submitted = await call(app, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "submit_batch", arguments: batch },
    });
    const submittedBody = (await submitted.json()) as { result?: { structuredContent?: { batchId?: string } } };
    const batchId = submittedBody.result?.structuredContent?.batchId;
    expect(batchId).toBeTypeOf("string");

    const first = await call(app, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "inspect_batch", arguments: { batchId, limit: 1 } },
    });
    const firstBody = (await first.json()) as { result?: { structuredContent?: { entries?: unknown[]; nextCursor?: string | null } } };
    expect(firstBody.result?.structuredContent?.entries).toHaveLength(1);
    expect(firstBody.result?.structuredContent?.nextCursor).toBeTypeOf("string");

    const replay = await call(app, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "submit_batch", arguments: batch },
    });
    const replayBody = (await replay.json()) as { result?: { structuredContent?: { batchId?: string } } };
    expect(replayBody.result?.structuredContent?.batchId).toBe(batchId);
  });

  test("reads the same team-supplied activation projection and obeys token scope narrowing", async () => {
    const activation: SharedActivationSummary = {
      summaryId: "workspace_activation_summary:demo",
      workspaceSlug: "demo",
      contractVersion: "1",
      status: "active",
      summary: {
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
      },
      suppliedAt: "2026-09-22T12:00:00.000Z",
      updatedAt: "2026-09-22T12:00:00.000Z",
      sourceTrust: "team_supplied",
    };
    const activationService = new ActivationSummaryService({
      async resolveAdmin() { return null; },
      async findIdempotent() { return null; },
      async share(_input: { summary: ActivationSummaryV1 }) { return activation; },
      async withdraw() { return { ...activation, status: "withdrawn", summary: null }; },
      async list() { return [activation]; },
      async get() { return activation; },
    });
    const service = new PlatformContentService({ store: new InMemoryPlatformContentStore(), sources: [source] });
    let followUp: FollowUpItem | null = null;
    const followUpService = new OpsFollowUpService({
      async listActiveSummaries() { return [activation]; },
      async getSummary() { return activation; },
      async findIdempotent() { return null; },
      async create(input) {
        followUp = {
          followUpId: "activation_follow_up:demo", workspaceSlug: input.workspaceSlug, summaryId: input.summaryId,
          reason: input.reason, period: input.period, dedupeKey: input.dedupeKey,
          sourceContractVersion: input.sourceContractVersion, sourceUpdatedAt: input.sourceUpdatedAt,
          sourceAvailable: true, sourceFreshness: "fresh", status: "open", ownerSubject: null, leaseExpiresAt: null,
          dueCheckAt: input.dueCheckAt, result: null, version: 1,
          createdAt: activation.updatedAt, updatedAt: activation.updatedAt, nextStep: "claim",
        };
        return followUp;
      },
      async list() { return followUp ? [followUp] : []; },
      async get() { return followUp; },
      async claim(input) {
        if (!followUp || followUp.version !== input.expectedVersion) return null;
        followUp = { ...followUp, ownerSubject: input.actorSubject, leaseExpiresAt: input.leaseExpiresAt, status: "claimed", version: 2, nextStep: "update" };
        return followUp;
      },
      async update(input) {
        if (!followUp || followUp.version !== input.expectedVersion || followUp.ownerSubject !== input.actorSubject) return null;
        followUp = { ...followUp, status: input.status, dueCheckAt: input.dueCheckAt, result: input.result, version: 3, nextStep: "none" };
        return followUp;
      },
    }, () => new Date("2026-09-22T12:00:00.000Z"));
    const app = new Hono<AppBindings>();
    app.onError(handleError);
    app.route("/", createContentMcpRoutes({
      service,
      activationSummaryService: activationService,
      opsFollowUpService: followUpService,
      authorizationServer: "https://auth.example.test",
      requireOperator: async (c, next) => {
        c.set("user", { subject: "operator:ada", raw: { scope: "activation.summary.read activation.followup.read" }, rawToken: "token" });
        c.set("platformOperator", { subject: "operator:ada", capabilities: ["activation.summary.read", "activation.followup.read", "activation.followup.write"] });
        await next();
      },
    }));
    const response = await call(app, {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "list_activation_summaries", arguments: { limit: 10 } },
    });
    const body = await response.json() as { result?: { structuredContent?: { items?: SharedActivationSummary[] } } };
    expect(body.result?.structuredContent?.items?.[0]).toEqual(activation);

    const opportunityResponse = await call(app, {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "list_activation_opportunities", arguments: { limit: 1 } },
    });
    const opportunityBody = await opportunityResponse.json() as { result?: { structuredContent?: { items?: Array<{ freshness?: string; nextStep?: string }> } } };
    expect(opportunityBody.result?.structuredContent?.items?.[0]).toMatchObject({ freshness: "fresh", nextStep: "create_follow_up" });

    const deniedCreate = await call(app, {
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: { name: "create_follow_up", arguments: { opportunityId: "x", dueCheckAt: null, idempotencyKey: "mcp-create-0001" } },
    });
    const deniedBody = await deniedCreate.json() as { result?: { structuredContent?: { error?: { code?: string } } } };
    expect(deniedBody.result?.structuredContent?.error?.code).toBe("capability_missing");

    const writableApp = new Hono<AppBindings>();
    writableApp.onError(handleError);
    writableApp.route("/", createContentMcpRoutes({
      service, activationSummaryService: activationService, opsFollowUpService: followUpService,
      authorizationServer: "https://auth.example.test",
      requireOperator: async (c, next) => {
        c.set("user", { subject: "operator:ada", raw: { scope: "activation.summary.read activation.followup.read activation.followup.write" }, rawToken: "token" });
        c.set("platformOperator", { subject: "operator:ada", capabilities: ["activation.summary.read", "activation.followup.read", "activation.followup.write"] });
        await next();
      },
    }));
    const opportunityId = (opportunityBody.result?.structuredContent?.items?.[0] as { opportunityId?: string } | undefined)?.opportunityId;
    const createdResponse = await call(writableApp, { jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "create_follow_up", arguments: { opportunityId, dueCheckAt: null, idempotencyKey: "mcp-create-0002" } } });
    const created = await createdResponse.json() as { result?: { structuredContent?: FollowUpItem } };
    expect(created.result?.structuredContent).toMatchObject({ followUpId: "activation_follow_up:demo", nextStep: "claim" });
    const claimedResponse = await call(writableApp, { jsonrpc: "2.0", id: 24, method: "tools/call", params: { name: "claim_follow_up", arguments: { followUpId: "activation_follow_up:demo", expectedVersion: 1, leaseSeconds: 60, idempotencyKey: "mcp-claim-0001" } } });
    const claimed = await claimedResponse.json() as { result?: { structuredContent?: FollowUpItem } };
    expect(claimed.result?.structuredContent).toMatchObject({ status: "claimed", version: 2, ownerSubject: "operator:ada" });
    const updatedResponse = await call(writableApp, { jsonrpc: "2.0", id: 25, method: "tools/call", params: { name: "update_follow_up", arguments: { followUpId: "activation_follow_up:demo", expectedVersion: 2, status: "resolved", dueCheckAt: null, result: "已处理", idempotencyKey: "mcp-update-0001" } } });
    const updated = await updatedResponse.json() as { result?: { structuredContent?: FollowUpItem } };
    expect(updated.result?.structuredContent).toMatchObject({ status: "resolved", result: "已处理", nextStep: "none" });
  });
});
