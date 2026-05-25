import { Hono } from "hono";
import { handleError } from "./middleware/error";
import { requestLogger } from "./middleware/logger";
import { healthRoutes } from "./routes/health";
import { createAiChatRoutes, type AiChatService, type CallerSessionFactory } from "./routes/ai-chat";
import { createInternalIdpRoutes } from "./routes/internal-idp";
import { createMemberRoutes } from "./routes/members";
import { createSessionRoutes } from "./routes/session";
import { createWorkspaceRoutes } from "./routes/workspaces";
import { createRunRegistry, type RunRegistry } from "./ai/run-registry";
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
  /** run 注册表（owner + streamToken）；默认进程内单例由 createApp 自建。 */
  runRegistry?: RunRegistry;
};

/** 默认 AI 服务：AI 装配未接线时让 /api/chat 明确返回 501，而不是 404 / 静默 500。 */
const NOT_WIRED_AI_SERVICE: AiChatService = {
  async startChat() {
    throw new HttpError(501, "ai-not-configured", "AI chat service is not wired up in this deployment");
  },
  async resumeChat() {
    throw new HttpError(501, "ai-not-configured", "AI chat service is not wired up in this deployment");
  },
};

export function createApp(options: AppOptions = {}): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const workspaceScope = options.workspaceScope ?? createWorkspaceScopeModule();
  const idpTokenScopeAdapter = options.idpTokenScopeAdapter ?? createIdpTokenScopeAdapter();
  const workspaceCreator = options.workspaceCreator ?? createWorkspaceCreator({ idpTokenScopeAdapter });
  const memberManager = options.memberManager ?? createMemberManager();

  app.use("*", requestLogger);
  app.onError(handleError);
  app.route("/", healthRoutes);
  app.route("/", createInternalIdpRoutes(workspaceScope));
  app.route("/", createSessionRoutes(workspaceScope, idpTokenScopeAdapter, options.requireUser));
  app.route("/", createWorkspaceRoutes(workspaceCreator, options.requireUser));
  app.route("/", createMemberRoutes(memberManager, options.requireUser));
  app.route(
    "/",
    createAiChatRoutes({
      service: options.aiChatService ?? NOT_WIRED_AI_SERVICE,
      createCallerSession: options.createCallerSession ?? ((rawToken) => createCallerSession(rawToken)),
      registry: options.runRegistry ?? createRunRegistry(),
      requireUser: options.requireUser,
    }),
  );

  return app;
}

export type AppType = ReturnType<typeof createApp>;
