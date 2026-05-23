import { Hono } from "hono";
import { handleError } from "./middleware/error";
import { requestLogger } from "./middleware/logger";
import { healthRoutes } from "./routes/health";
import { createInternalIdpRoutes } from "./routes/internal-idp";
import { createMemberRoutes } from "./routes/members";
import { createSessionRoutes } from "./routes/session";
import { createWorkspaceRoutes } from "./routes/workspaces";
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

  return app;
}

export type AppType = ReturnType<typeof createApp>;
