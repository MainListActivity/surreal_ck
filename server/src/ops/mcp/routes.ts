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
import {
  ActivationSummaryService,
  ActivationSummaryServiceError,
} from "../../activation-summary/service";
import { OpsFollowUpService, OpsFollowUpServiceError } from "../../ops-follow-up/service";

const MCP_SCOPES = [
  "content.read",
  "content.submit",
  "content.publish",
  "content.withdraw",
  "content.restore",
  "content.source.manage",
  "activation.summary.read",
  "activation.followup.read",
  "activation.followup.write",
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
      : error instanceof ActivationSummaryServiceError
        ? { error: { code: error.code, message: error.message } }
      : error instanceof OpsFollowUpServiceError
        ? { error: { code: error.code, message: error.message } }
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

function publicRequestUrl(input: Readonly<{
  requestUrl: string;
  forwardedHost?: string;
  forwardedProto?: string;
}>): URL {
  const url = new URL(input.requestUrl);
  const forwardedHost = input.forwardedHost?.split(",", 1)[0]?.trim();
  const forwardedProto = input.forwardedProto?.trim().toLowerCase();
  if (
    forwardedHost !== undefined &&
    /^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/u.test(forwardedHost) &&
    (forwardedProto === "http" || forwardedProto === "https")
  ) {
    url.host = forwardedHost;
    url.protocol = `${forwardedProto}:`;
  }
  return url;
}

function resourceMetadataUrl(input: Readonly<{
  requestUrl: string;
  forwardedHost?: string;
  forwardedProto?: string;
}>): string {
  const url = publicRequestUrl(input);
  return `${url.origin}/api/ops/.well-known/oauth-protected-resource`;
}

function mcpResourceUrl(input: Readonly<{
  requestUrl: string;
  forwardedHost?: string;
  forwardedProto?: string;
}>): string {
  const url = publicRequestUrl(input);
  url.pathname = "/api/ops/mcp";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function withMcpBearerChallenge(
  middleware: MiddlewareHandler<AppBindings>,
  metadataUrl: (input: {
    requestUrl: string;
    forwardedHost?: string;
    forwardedProto?: string;
  }) => string,
): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    try {
      await middleware(c, next);
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        c.header(
          "WWW-Authenticate",
          `Bearer resource_metadata="${metadataUrl({
            requestUrl: c.req.url,
            forwardedHost:
              c.req.header("x-surreal-ck-public-host") ?? c.req.header("x-forwarded-host"),
            forwardedProto:
              c.req.header("x-surreal-ck-public-proto") ?? c.req.header("x-forwarded-proto"),
          })}"`,
        );
      }
      throw error;
    }
  };
}

function buildServer(
  service: PlatformContentService,
  operator: ContentOperator,
  activationSummaryService?: ActivationSummaryService,
  opsFollowUpService?: OpsFollowUpService,
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

  if (activationSummaryService) {
    server.registerTool(
      "list_activation_summaries",
      {
        title: "列出团队启用摘要",
        description: "稳定分页读取工作区管理员主动共享的最小启用摘要。v2 保留指标状态、持久证据来源、固定分母、时区周期与更新时间；未知、不适用、未完成、失败和结果待核实不得合并。摘要为团队提供，不用于计费或权限判断。",
        inputSchema: toolInputSchema,
      },
      async (args) => {
        try {
          const limit = typeof args.limit === "number" ? args.limit : undefined;
          const cursor = typeof args.cursor === "string" ? args.cursor : undefined;
          return toolSuccess(await activationSummaryService.list(operator, { limit, cursor }));
        } catch (error) {
          return toolError(error);
        }
      },
    );
    server.registerTool(
      "get_activation_summary",
      {
        title: "读取团队启用摘要",
        description: "按摘要 ID 读取同一运营服务中的授权摘要详情，并按 source、period、updatedAt 解释 v2 指标口径与新鲜度。",
        inputSchema: toolInputSchema,
      },
      async (args) => {
        try {
          if (typeof args.summaryId !== "string" || args.summaryId.length === 0) {
            throw new ActivationSummaryServiceError("invalid_request", "summaryId 必填");
          }
          return toolSuccess(await activationSummaryService.get(operator, args.summaryId));
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  if (opsFollowUpService) {
    server.registerTool(
      "list_activation_opportunities",
      {
        title: "列出启用支持机会",
        description: "稳定分页列出从未撤回、新鲜且结论明确的授权摘要派生的内部支持机会。未知或陈旧摘要不会被当作流失事实。",
        inputSchema: toolInputSchema,
      },
      async (args) => {
        try {
          return toolSuccess(await opsFollowUpService.listOpportunities(operator, {
            limit: typeof args.limit === "number" ? args.limit : undefined,
            cursor: typeof args.cursor === "string" ? args.cursor : undefined,
          }));
        } catch (error) { return toolError(error); }
      },
    );
    server.registerTool(
      "list_follow_ups",
      { title: "列出内部跟进队列", description: "稳定分页列出内部跟进事项；摘要撤回后只返回最小历史并标记来源不可用。", inputSchema: toolInputSchema },
      async (args) => {
        try {
          return toolSuccess(await opsFollowUpService.listFollowUps(operator, {
            limit: typeof args.limit === "number" ? args.limit : undefined,
            cursor: typeof args.cursor === "string" ? args.cursor : undefined,
          }));
        } catch (error) { return toolError(error); }
      },
    );
    server.registerTool(
      "create_follow_up",
      { title: "创建内部跟进事项", description: "按机会稳定身份创建或去重内部事项，不发送任何外部消息。", inputSchema: toolInputSchema },
      async (args) => {
        try {
          if (typeof args.opportunityId !== "string" || typeof args.idempotencyKey !== "string" || (args.dueCheckAt !== null && args.dueCheckAt !== undefined && typeof args.dueCheckAt !== "string")) throw new OpsFollowUpServiceError("invalid_request", "opportunityId 与 idempotencyKey 必填");
          return toolSuccess(await opsFollowUpService.create(operator, { opportunityId: args.opportunityId, dueCheckAt: typeof args.dueCheckAt === "string" ? args.dueCheckAt : null, idempotencyKey: args.idempotencyKey }));
        } catch (error) { return toolError(error); }
      },
    );
    server.registerTool(
      "claim_follow_up",
      { title: "认领内部跟进事项", description: "用预期版本和有期限租约认领事项；竞争者只能有一个成功。", inputSchema: toolInputSchema },
      async (args) => {
        try {
          if (typeof args.followUpId !== "string" || typeof args.expectedVersion !== "number" || typeof args.leaseSeconds !== "number" || typeof args.idempotencyKey !== "string") throw new OpsFollowUpServiceError("invalid_request", "认领参数不完整");
          return toolSuccess(await opsFollowUpService.claim(operator, { followUpId: args.followUpId, expectedVersion: args.expectedVersion, leaseSeconds: args.leaseSeconds, idempotencyKey: args.idempotencyKey }));
        } catch (error) { return toolError(error); }
      },
    );
    server.registerTool(
      "update_follow_up",
      { title: "更新内部跟进事项", description: "仅当前有效租约持有人可按预期版本更新状态、到期检查时间和结果。", inputSchema: toolInputSchema },
      async (args) => {
        try {
          const status = args.status;
          if (typeof args.followUpId !== "string" || typeof args.expectedVersion !== "number" || (status !== "waiting" && status !== "resolved" && status !== "dismissed") || typeof args.idempotencyKey !== "string") throw new OpsFollowUpServiceError("invalid_request", "更新参数不完整");
          return toolSuccess(await opsFollowUpService.update(operator, {
            followUpId: args.followUpId,
            expectedVersion: args.expectedVersion,
            status,
            dueCheckAt: typeof args.dueCheckAt === "string" ? args.dueCheckAt : null,
            result: typeof args.result === "string" ? args.result : null,
            idempotencyKey: args.idempotencyKey,
          }));
        } catch (error) { return toolError(error); }
      },
    );
  }

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
  activationSummaryService?: ActivationSummaryService;
  opsFollowUpService?: OpsFollowUpService;
  resourceUri?: string;
  authorizationServer?: string;
  requireOperator?: MiddlewareHandler<AppBindings>;
}>) {
  const authorizationServer = input.authorizationServer ?? env.OIDC_ISSUER;
  const authenticate = withMcpBearerChallenge(
    input.requireOperator ?? requirePlatformOperator(),
    resourceMetadataUrl,
  );
  const app = new Hono<AppBindings>();

  const resourceForRequest = (requestUrl: string, forwardedHost?: string, forwardedProto?: string) =>
    input.resourceUri ?? mcpResourceUrl({ requestUrl, forwardedHost, forwardedProto });

  app.get("/api/ops/.well-known/oauth-protected-resource", (c) =>
    c.json(
      protectedResourceMetadata({
        authorizationServer,
        resource: resourceForRequest(
          c.req.url,
          c.req.header("x-surreal-ck-public-host") ?? c.req.header("x-forwarded-host"),
          c.req.header("x-surreal-ck-public-proto") ?? c.req.header("x-forwarded-proto"),
        ),
      }),
    ),
  );
  app.get("/api/ops/mcp/.well-known/oauth-protected-resource", (c) =>
    c.json(
      protectedResourceMetadata({
        authorizationServer,
        resource: resourceForRequest(
          c.req.url,
          c.req.header("x-surreal-ck-public-host") ?? c.req.header("x-forwarded-host"),
          c.req.header("x-surreal-ck-public-proto") ?? c.req.header("x-forwarded-proto"),
        ),
      }),
    ),
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
    }, input.activationSummaryService, input.opsFollowUpService);
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
