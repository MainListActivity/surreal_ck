import { Hono } from "hono";
import { handleError } from "./middleware/error";
import { requestLogger } from "./middleware/logger";
import { healthRoutes } from "./routes/health";
import { createAiChatRoutes, type AiChatService, type CallerSessionFactory } from "./routes/ai-chat";
import { createAiStreamRoutes } from "./routes/ai-stream";
import { createAiChatService } from "./ai/chat-service";
import { createMastraRunner } from "./ai/assemble-mastra";
import { env } from "./env";
import { createInternalIdpRoutes } from "./routes/internal-idp";
import { createMemberRoutes } from "./routes/members";
import { createSessionRoutes } from "./routes/session";
import { createWorkspaceRoutes } from "./routes/workspaces";
import { createRunRegistry, type RunRegistry } from "./ai/run-registry";
import { createRunBus, type RunBus } from "./ai/run-bus";
import { createCallerSession } from "./ai/caller-session";
import { HttpError } from "./http-error";
import { createWorkspaceCreator, type WorkspaceCreator } from "./workspaces/create-workspace";
import { createMemberManager, type MemberManager } from "./workspaces/member-manager";
import { createIdpTokenScopeAdapter, type IdpTokenScopeAdapter } from "./workspaces/idp-scope-adapter";
import { createWorkspaceScopeModule, type WorkspaceScopeModule } from "./workspaces/workspace-scope";
import type { AppBindings } from "./hono-types";
import type { MiddlewareHandler } from "hono";

export type AppOptions = {
  workspaceScope?: WorkspaceScopeModule;
  idpTokenScopeAdapter?: IdpTokenScopeAdapter;
  workspaceCreator?: WorkspaceCreator;
  memberManager?: MemberManager;
  requireUser?: () => MiddlewareHandler<AppBindings>;
  /** Mastra router workflow 启动 / 续跑服务。未注入时 /api/chat 返回 501（AI 装配在后续簇接线）。 */
  aiChatService?: AiChatService;
  /** 用调用者 OIDC token authenticate 出 SurrealDB 会话；默认走 createCallerSession。 */
  createCallerSession?: CallerSessionFactory;
  /** run 注册表（owner + streamToken）；默认进程内单例由 createApp 自建。/api/chat 与 /api/chat/stream 共用同一实例。 */
  runRegistry?: RunRegistry;
  /** router workflow 运行过程事件总线（progress/chunk/suspend/done）；默认进程内单例。 */
  runBus?: RunBus;
};

type AiStreamWebSocket = ReturnType<typeof createAiStreamRoutes>["websocket"];

/** createApp 返回的 Hono 实例上额外挂载的 Bun WS handler；startup 把它透传给 Bun.serve。 */
export type AppWithWebSocket = Hono<AppBindings> & {
  websocket: AiStreamWebSocket;
};

/**
 * 生产 AI 自动装配：env 中 AI_PROVIDER / AI_MODEL / AI_API_KEY 三者齐备才接线（生产部署默认走这条）。
 * 任何一项缺失 → 返回 undefined，调用方落到 NOT_WIRED_AI_SERVICE 的 501，部署可观测、不静默。
 */
function buildAutoAiChatService(runBus: RunBus): AiChatService | undefined {
  if (!env.AI_PROVIDER || !env.AI_MODEL || !env.AI_API_KEY) return undefined;
  const { runner, resumer } = createMastraRunner({
    settings: {
      provider: env.AI_PROVIDER,
      model: env.AI_MODEL,
      apiKey: env.AI_API_KEY,
      baseUrl: env.AI_BASE_URL,
    },
  });
  return createAiChatService({ runBus, runner, resumer });
}

/** 默认 AI 服务：AI 装配未接线时让 /api/chat 明确返回 501，而不是 404 / 静默 500。 */
const NOT_WIRED_AI_SERVICE: AiChatService = {
  async startChat() {
    throw new HttpError(501, "ai-not-configured", "AI chat service is not wired up in this deployment");
  },
  async resumeChat() {
    throw new HttpError(501, "ai-not-configured", "AI chat service is not wired up in this deployment");
  },
};

/**
 * 装配所有路由，返回链式 .route() 推导出的 Hono（**保留** 每条子路由 schema）。
 * 一旦改回逐条 in-place `app.route(...)` 调用或给返回值标 `: Hono<AppBindings>`，
 * schema 会被丢弃、hc<AppType> 的 path 退化为 unknown。AppType 从这里推导。
 */
function buildRoutes(options: AppOptions, aiStream: ReturnType<typeof createAiStreamRoutes>) {
  const workspaceScope = options.workspaceScope ?? createWorkspaceScopeModule();
  const idpTokenScopeAdapter = options.idpTokenScopeAdapter ?? createIdpTokenScopeAdapter();
  const workspaceCreator = options.workspaceCreator ?? createWorkspaceCreator({ idpTokenScopeAdapter });
  const memberManager = options.memberManager ?? createMemberManager();
  const runRegistry = options.runRegistry ?? createRunRegistry();
  const runBus = options.runBus ?? createRunBus();
  const autoAiChatService = options.aiChatService ?? buildAutoAiChatService(runBus);

  const base = new Hono<AppBindings>();
  base.use("*", requestLogger);
  base.onError(handleError);

  return base
    .route("/", healthRoutes)
    .route("/", createInternalIdpRoutes(workspaceScope))
    .route("/", createSessionRoutes(workspaceScope, idpTokenScopeAdapter, options.requireUser))
    .route("/", createWorkspaceRoutes(workspaceCreator, options.requireUser))
    .route("/", createMemberRoutes(memberManager, options.requireUser))
    .route(
      "/",
      createAiChatRoutes({
        service: autoAiChatService ?? NOT_WIRED_AI_SERVICE,
        createCallerSession: options.createCallerSession ?? ((rawToken) => createCallerSession(rawToken)),
        registry: runRegistry,
        requireUser: options.requireUser,
      }),
    )
    .route("/", aiStream.routes);
}

/** 端到端类型来源：route schema 完整的 Hono，供 web 端 hc<AppType> 推导。 */
export type AppType = ReturnType<typeof buildRoutes>;

export function createApp(options: AppOptions = {}): AppWithWebSocket {
  // /api/chat（注册 run）与 /api/chat/stream（按 streamToken 订阅）必须共用同一注册表与总线。
  const runRegistry = options.runRegistry ?? createRunRegistry();
  const runBus = options.runBus ?? createRunBus();
  const aiStream = createAiStreamRoutes({ registry: runRegistry, bus: runBus });
  const app = buildRoutes({ ...options, runRegistry, runBus }, aiStream);

  // 把 Bun WS handler 挂到 app 上，startup 透传给 Bun.serve；不改变 app 的 fetch/request 用法。
  return Object.assign(app, { websocket: aiStream.websocket }) as unknown as AppWithWebSocket;
}
