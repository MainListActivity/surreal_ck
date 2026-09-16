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
});
