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
import { OpsProposalService, OpsProposalServiceError, type OpsProposalActor } from "../../ops-proposal/service";
import { OpsAutonomyService, OpsAutonomyError } from "../../ops-autonomy/service";
import { OpsRunService, OpsRunError } from "../../ops-run/service";

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
  "activation.proposal.read",
  "activation.proposal.submit",
  "activation.proposal.review",
  "activation.proposal.execute",
  "activation.proposal.takeover",
  "activation.autonomy.read",
  "activation.autonomy.manage",
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
      : error instanceof OpsProposalServiceError
        ? { error: { code: error.code, message: error.message } }
      : error instanceof OpsAutonomyError
        ? { error: { code: error.code, message: error.message } }
      : error instanceof OpsRunError
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
  operator: ContentOperator & OpsProposalActor,
  activationSummaryService?: ActivationSummaryService,
  opsFollowUpService?: OpsFollowUpService,
  opsProposalService?: OpsProposalService,
  opsAutonomyService?: OpsAutonomyService,
  opsRunService?: OpsRunService,
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
        if (operator.kind === "agent") throw new OpsAutonomyError("out_of_scope", "该工具不在 agent 自治动作范围内");
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

  if (opsProposalService) {
    server.registerTool("list_ops_proposals", {
      title: "列出运营建议", description: "稳定分页读取待审阅建议及真实执行结果。", inputSchema: toolInputSchema,
    }, async (args) => {
      try { return toolSuccess(await opsProposalService.list(operator, { limit: typeof args.limit === "number" ? args.limit : undefined, cursor: typeof args.cursor === "string" ? args.cursor : undefined })); }
      catch (error) { return toolError(error); }
    });
    server.registerTool("get_ops_proposal", {
      title: "读取运营建议", description: "读取建议动作、依据、审阅状态和实际工具结果。", inputSchema: toolInputSchema,
    }, async (args) => {
      try {
        if (typeof args.proposalId !== "string") throw new OpsProposalServiceError("invalid_request", "proposalId 必填");
        return toolSuccess(await opsProposalService.get(operator, args.proposalId));
      } catch (error) { return toolError(error); }
    });
    server.registerTool("submit_ops_proposal", {
      title: "提交运营建议", description: "只允许提议现有内部跟进动作；提交不执行。agentId 仅从已验证 token 的 act claim 获取。", inputSchema: toolInputSchema,
    }, async (args) => {
      try { return toolSuccess(await opsProposalService.submit(operator, args)); }
      catch (error) { return toolError(error); }
    });
    server.registerTool("review_ops_proposal", {
      title: "人工审阅运营建议", description: "绑定建议版本及动作摘要审批或拒绝；审批本身不执行。", inputSchema: toolInputSchema,
    }, async (args) => {
      try {
        if (typeof args.proposalId !== "string" || typeof args.expectedVersion !== "number" || typeof args.actionDigest !== "string" || (args.decision !== "approve" && args.decision !== "reject") || typeof args.reason !== "string" || typeof args.idempotencyKey !== "string") throw new OpsProposalServiceError("invalid_request", "审阅参数不完整");
        return toolSuccess(await opsProposalService.review(operator, { proposalId: args.proposalId, expectedVersion: args.expectedVersion, actionDigest: args.actionDigest, decision: args.decision, reason: args.reason, idempotencyKey: args.idempotencyKey }));
      } catch (error) { return toolError(error); }
    });
    server.registerTool("execute_ops_proposal", {
      title: "执行已审批运营建议", description: "重新验证版本、来源和当前 capability，仅执行受限内部跟进动作。", inputSchema: toolInputSchema,
    }, async (args) => {
      try {
        if (typeof args.proposalId !== "string" || typeof args.expectedVersion !== "number" || typeof args.idempotencyKey !== "string") throw new OpsProposalServiceError("invalid_request", "执行参数不完整");
        return toolSuccess(await opsProposalService.execute(operator, { proposalId: args.proposalId, expectedVersion: args.expectedVersion, idempotencyKey: args.idempotencyKey }));
      } catch (error) { return toolError(error); }
    });
    server.registerTool("takeover_follow_up", {
      title: "人工接管内部事项", description: "人工按事项版本覆盖旧租约，旧认领和基于旧版本的建议立即失效。", inputSchema: toolInputSchema,
    }, async (args) => {
      try {
        if (typeof args.followUpId !== "string" || typeof args.expectedVersion !== "number" || typeof args.leaseSeconds !== "number" || typeof args.reason !== "string" || typeof args.idempotencyKey !== "string") throw new OpsProposalServiceError("invalid_request", "接管参数不完整");
        return toolSuccess(await opsProposalService.takeover(operator, { followUpId: args.followUpId, expectedVersion: args.expectedVersion, leaseSeconds: args.leaseSeconds, reason: args.reason, idempotencyKey: args.idempotencyKey }));
      } catch (error) { return toolError(error); }
    });
  }

  if (opsFollowUpService && opsProposalService) {
    server.registerTool("verify_ops_action", {
      title: "核实待完成内部动作", description: "按调用者和稳定幂等键只读核实已落库结果；未找到时返回 null。", inputSchema: toolInputSchema,
    }, async (args) => {
      try {
        if (typeof args.tool !== "string" || typeof args.idempotencyKey !== "string") throw new OpsRunError("invalid_request", "动作和幂等键必填");
        const { tool, ...request } = args;
        if (tool === "submit_ops_proposal") return toolSuccess({ item: await opsProposalService.verifySubmittedAction(operator, request) });
        if (tool === "create_follow_up" || tool === "claim_follow_up" || tool === "update_follow_up") {
          const action = tool === "create_follow_up" ? "follow_up.create" : tool === "claim_follow_up" ? "follow_up.claim" : "follow_up.update";
          return toolSuccess({ item: await opsFollowUpService.verifyAction(operator, action, request) });
        }
        throw new OpsRunError("invalid_request", "不支持的动作");
      } catch (error) { return toolError(error); }
    });
  }

  if (opsAutonomyService) {
    server.registerTool("list_agent_policies", {
      title: "列出 agent 自治授权", description: "真人运营人员查看工作区动作白名单与暂停状态。", inputSchema: toolInputSchema,
    }, async (args) => {
      try { return toolSuccess(await opsAutonomyService.list(operator, typeof args.agentSubject === "string" ? args.agentSubject : undefined)); }
      catch (error) { return toolError(error); }
    });
    server.registerTool("list_agent_policy_history", {
      title: "读取自治授权历史", description: "读取配置、暂停、恢复和撤权审计。", inputSchema: toolInputSchema,
    }, async (args) => {
      try { return toolSuccess(await opsAutonomyService.history(operator, typeof args.policyId === "string" ? args.policyId : undefined)); }
      catch (error) { return toolError(error); }
    });
    server.registerTool("configure_agent_policy", {
      title: "配置 agent 工作区动作范围", description: "仅真人可配置，且不能授予双方均未持有的能力。", inputSchema: toolInputSchema,
    }, async (args) => {
      try { return toolSuccess(await opsAutonomyService.configure(operator, args)); }
      catch (error) { return toolError(error); }
    });
    server.registerTool("change_agent_policy_status", {
      title: "暂停、恢复或撤销 agent 自治", description: "实时变更该工作区动作策略；已完成动作不回滚。", inputSchema: toolInputSchema,
    }, async (args) => {
      try {
        const status = args.status;
        if (typeof args.policyId !== "string" || typeof args.expectedVersion !== "number" || (status !== "active" && status !== "paused" && status !== "revoked") || typeof args.reason !== "string" || typeof args.idempotencyKey !== "string") throw new OpsAutonomyError("invalid_request", "状态参数不完整");
        return toolSuccess(await opsAutonomyService.changeStatus(operator, { policyId: args.policyId, expectedVersion: args.expectedVersion, status, reason: args.reason, idempotencyKey: args.idempotencyKey }));
      } catch (error) { return toolError(error); }
    });
  }

  if (opsRunService) {
    server.registerTool("get_agent_run_checkpoint", {
      title: "读取自身运行检查点", description: "按工作区和运行键恢复 agent 检查点；暂停后不可继续读取。", inputSchema: toolInputSchema,
    }, async (args) => {
      try {
        if (typeof args.workspaceSlug !== "string" || typeof args.runKey !== "string") throw new OpsRunError("invalid_request", "工作区和运行键必填");
        return toolSuccess({ item: await opsRunService.get(operator, args.workspaceSlug, args.runKey) });
      } catch (error) { return toolError(error); }
    });
    server.registerTool("save_agent_run_checkpoint", {
      title: "保存自身运行检查点", description: "用版本前提持久化游标、待核实动作和重试状态；不代表业务动作已成功。", inputSchema: toolInputSchema,
    }, async (args) => {
      try { return toolSuccess(await opsRunService.save(operator, args)); }
      catch (error) { return toolError(error); }
    });
    server.registerTool("list_agent_runs", {
      title: "查看 agent 运行进度", description: "真人运营人员查看最新运行、失败和待人工处理状态。", inputSchema: toolInputSchema,
    }, async () => {
      try { return toolSuccess(await opsRunService.list(operator)); }
      catch (error) { return toolError(error); }
    });
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
        if (operator.kind === "agent") throw new OpsAutonomyError("out_of_scope", "该工具不在 agent 自治动作范围内");
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
        if (operator.kind === "agent") throw new OpsAutonomyError("out_of_scope", "该工具不在 agent 自治动作范围内");
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
        if (operator.kind === "agent") throw new OpsAutonomyError("out_of_scope", "该工具不在 agent 自治动作范围内");
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
        if (operator.kind === "agent") throw new OpsAutonomyError("out_of_scope", "该工具不在 agent 自治动作范围内");
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
  opsProposalService?: OpsProposalService;
  opsAutonomyService?: OpsAutonomyService;
  opsRunService?: OpsRunService;
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
        ? operator.kind === "agent" ? [] : operator.capabilities
        : operator.capabilities.filter((capability) => tokenScopes.has(capability));
    const server = buildServer(input.service, {
      subject: operator.subject,
      kind: operator.kind,
      capabilities: effectiveCapabilities,
      agentId: operator.kind === "agent" ? operator.subject : c.var.user?.raw?.act && typeof c.var.user.raw.act === "object" && "sub" in c.var.user.raw.act && typeof c.var.user.raw.act.sub === "string" ? c.var.user.raw.act.sub : null,
    }, input.activationSummaryService, input.opsFollowUpService, input.opsProposalService, input.opsAutonomyService, input.opsRunService);
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
