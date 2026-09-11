import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z, ZodError } from "zod";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppBindings } from "../../hono-types";
import { HttpError } from "../../http-error";
import { env } from "../../env";
import { requirePlatformOperator } from "../operator-auth";
import {
  ContentServiceError,
  type ContentOperator,
  type PlatformContentService,
} from "../../content/service";

const MCP_SCOPES = [
  "content.read",
  "content.submit",
  "content.publish",
  "content.withdraw",
  "content.restore",
  "content.source.manage",
] as const;

const toolInputSchema = z.record(z.string(), z.unknown());

function jsonSafe(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: { code: "serialization_error", message: "工具结果无法序列化" } });
  }
}

function toolError(error: unknown) {
  const payload =
    error instanceof ContentServiceError
      ? {
          error: {
            code: error.code,
            message: error.message,
            ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
          },
        }
      : error instanceof ZodError
        ? {
            error: {
              code: "invalid_request",
              message: "工具输入不符合数据契约",
              details: { issues: error.issues },
            },
          }
        : {
            error: { code: "internal", message: "工具执行失败" },
          };

  return {
    isError: true,
    content: [{ type: "text" as const, text: jsonSafe(payload) }],
    structuredContent: payload,
  };
}

function toolSuccess(value: unknown) {
  return {
    content: [{ type: "text" as const, text: jsonSafe(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function configuredResource(input: Readonly<{ resourceUri?: string }>): string {
  const resource = input.resourceUri ?? env.OIDC_OPS_AUDIENCE ?? env.OIDC_AUDIENCE;
  if (!resource) {
    throw new HttpError(503, "oidc-ops-audience-not-configured", "运营 MCP resource 未配置");
  }
  return resource;
}

function protectedResourceMetadata({
  authorizationServer,
  resource,
}: Readonly<{ authorizationServer: string; resource: string }>) {
  return {
    resource,
    authorization_servers: [authorizationServer],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ["header"],
  };
}

function resourceMetadataUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  return `${url.origin}/api/ops/.well-known/oauth-protected-resource`;
}

function withMcpBearerChallenge(
  middleware: MiddlewareHandler<AppBindings>,
  metadataUrl: (requestUrl: string) => string,
): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    try {
      await middleware(c, next);
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        c.header(
          "WWW-Authenticate",
          `Bearer resource_metadata="${metadataUrl(c.req.url)}"`,
        );
      }
      throw error;
    }
  };
}

function buildServer(
  service: PlatformContentService,
  operator: ContentOperator,
): McpServer {
  const server = new McpServer(
    { name: "surreal-ck-platform-content", version: "1.0.0" },
    {
      capabilities: { tools: { listChanged: false } },
      instructions:
        "平台法律内容维护工具。先 get_data_contract，提交后先 inspect_batch，再由人工审阅结果决定 publish_batch。",
    },
  );

  server.registerTool(
    "get_data_contract",
    {
      title: "获取内容数据契约",
      description: "返回平台法律内容五工具的版本、来源与限制。",
      inputSchema: toolInputSchema,
    },
    async (args) => {
      try {
        return toolSuccess(await service.getDataContract(operator, args));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "search_content",
    {
      title: "检索已发布法律内容",
      description: "按关键词、内容类型、来源、案号或发布状态检索平台内容。",
      inputSchema: toolInputSchema,
    },
    async (args) => {
      try {
        return toolSuccess(await service.searchContent(operator, args));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "submit_batch",
    {
      title: "提交清洗后的内容批次",
      description: "提交成品法规或公开裁判文书批次，服务端进行严格校验、去重和幂等处理。",
      inputSchema: toolInputSchema,
    },
    async (args) => {
      try {
        return toolSuccess(await service.submitBatch(operator, args));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "inspect_batch",
    {
      title: "审阅内容批次",
      description: "读取批次校验修订、逐条问题和发布前提；不能代替人工审阅。",
      inputSchema: toolInputSchema,
    },
    async (args) => {
      try {
        return toolSuccess(await service.inspectBatchResponse(operator, args));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "publish_batch",
    {
      title: "发布经过审阅的内容",
      description: "按 validationRevision 和明确 entryKeys 发布、修订、撤回或恢复内容。",
      inputSchema: toolInputSchema,
    },
    async (args) => {
      try {
        return toolSuccess(await service.publishBatch(operator, args));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}

export function createContentMcpRoutes(input: Readonly<{
  service: PlatformContentService;
  resourceUri?: string;
  authorizationServer?: string;
  requireOperator?: MiddlewareHandler<AppBindings>;
}>) {
  const resource = configuredResource(input);
  const authorizationServer = input.authorizationServer ?? env.OIDC_ISSUER;
  const authenticate = withMcpBearerChallenge(
    input.requireOperator ?? requirePlatformOperator(),
    resourceMetadataUrl,
  );
  const app = new Hono<AppBindings>();

  app.get("/api/ops/.well-known/oauth-protected-resource", (c) =>
    c.json(protectedResourceMetadata({ authorizationServer, resource })),
  );
  app.get("/api/ops/mcp/.well-known/oauth-protected-resource", (c) =>
    c.json(protectedResourceMetadata({ authorizationServer, resource })),
  );

  app.options("/api/ops/mcp", (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID");
    c.header("Access-Control-Expose-Headers", "WWW-Authenticate, MCP-Protocol-Version, MCP-Session-Id");
    return c.body(null, 204);
  });

  app.all("/api/ops/mcp", authenticate, async (c) => {
    const operator = c.var.platformOperator;
    if (!operator) {
      throw new HttpError(403, "platform-operator-required", "需要平台运营身份");
    }

    const tokenScopeClaim = c.var.user?.raw?.scope;
    const tokenScopes =
      typeof tokenScopeClaim === "string"
        ? new Set(tokenScopeClaim.split(/\s+/u).filter(Boolean))
        : null;
    const effectiveCapabilities =
      tokenScopes === null
        ? operator.capabilities
        : operator.capabilities.filter((capability) => tokenScopes.has(capability));
    const server = buildServer(input.service, {
      subject: operator.subject,
      capabilities: effectiveCapabilities,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    await server.connect(transport);

    try {
      const response = await transport.handleRequest(c.req.raw);
      response.headers.set("Access-Control-Allow-Origin", "*");
      response.headers.set(
        "Access-Control-Expose-Headers",
        "WWW-Authenticate, MCP-Protocol-Version, MCP-Session-Id",
      );
      return response;
    } finally {
      await server.close();
    }
  });

  return app;
}
