import type {
  AppBootstrap,
  AuthState,
  CreateBlankWorkbookRequest,
  CreateBlankWorkbookResponse,
  ListWorkbooksRequest,
  ListWorkbooksResponse,
  RawQueryRequest,
  RawQueryResponse,
  Result,
} from "../../shared/rpc.types";
import { getServiceContext, setOfflineMode, assertAuthenticated, assertWritable } from "../services/context";
import { withResult, ServiceError } from "../services/errors";
import { getLocalDb } from "../db/index";
import { startOidcLogin } from "../auth/oidc";
import { loginToSurrealDB, clearSession, getPublicAuthState } from "../auth/session";
import { initUserDb, closeUserDb } from "../db/index";
import { decodeTokenClaims, bootstrapLocalIdentity } from "../services/identity";

type SendFn = (event: "authStateChanged", payload: { state: AuthState }) => void;

/** 创建供 BrowserView.defineRPC handlers 字段消费的处理器对象。 */
export function createRpcHandlers(send: SendFn) {
  return {
    requests: {
      // ── 调试入口（Admin Console 专用）──────────────────────────────────
      query: async ({ sql }: RawQueryRequest): Promise<RawQueryResponse> => {
        const db = getLocalDb();
        const result = await db.query(sql);
        return result as unknown[];
      },

      getAuthState: async (): Promise<AuthState> => {
        const ctx = getServiceContext();
        return getPublicAuthState(ctx.isOffline ? { offlineMode: true } : undefined);
      },

      logout: async (): Promise<void> => {
        clearSession();
        setOfflineMode(false);
        await closeUserDb();
        const state = getPublicAuthState();
        send("authStateChanged", { state });
      },

      // ── 产品 API ───────────────────────────────────────────────────────

      getAppBootstrap: async (): Promise<Result<AppBootstrap>> => {
        return withResult(async () => {
          const ctx = getServiceContext();

          if (!ctx.isAuthenticated) {
            const data: AppBootstrap = {
              auth: getPublicAuthState(ctx.isOffline ? { offlineMode: true } : undefined),
              readOnly: true,
            };
            return data;
          }

          const db = getLocalDb();
          const userRows = await db.query<
            [{ id: unknown; subject: string; email?: string; name?: string; display_name?: string; avatar?: string }[]]
          >(`SELECT id, subject, email, name, display_name, avatar FROM app_user LIMIT 1`);
          const userRow = userRows[0]?.[0];

          if (!userRow) {
            throw new ServiceError("BOOTSTRAP_REQUIRED");
          }

          const wsRows = await db.query<[{ id: unknown; name: string; slug: string }[]]>(
            `SELECT id, name, slug FROM workspace WHERE owner = $userId LIMIT 1`,
            { userId: userRow.id }
          );
          const wsRow = wsRows[0]?.[0];

          if (!wsRow) {
            throw new ServiceError("BOOTSTRAP_REQUIRED");
          }

          return {
            auth: getPublicAuthState(ctx.isOffline ? { offlineMode: true } : undefined),
            readOnly: ctx.readOnly,
            user: {
              id: String(userRow.id),
              subject: userRow.subject,
              email: userRow.email,
              name: userRow.name,
              displayName: userRow.display_name,
              avatar: userRow.avatar,
            },
            defaultWorkspace: {
              id: String(wsRow.id),
              name: wsRow.name,
              slug: wsRow.slug,
            },
          } satisfies AppBootstrap;
        });
      },

      // 占位：Unit 3+ 实现业务逻辑
      listWorkbooks: async ({ workspaceId }: ListWorkbooksRequest): Promise<Result<ListWorkbooksResponse>> => {
        return withResult(async () => {
          assertCanReadWorkspace(workspaceId);
          throw new ServiceError("NOT_IMPLEMENTED");
        });
      },

      createBlankWorkbook: async ({
        workspaceId,
      }: CreateBlankWorkbookRequest): Promise<Result<CreateBlankWorkbookResponse>> => {
        return withResult(async () => {
          assertCanWriteWorkspace(workspaceId);
          throw new ServiceError("NOT_IMPLEMENTED");
        });
      },
    },

    messages: {
      log: ({ msg }: { msg: string }) => {
        console.log("[webview]", msg);
      },

      startLogin: () => {
        startOidcLogin()
          .then(async (tokens) => {
            const claims = decodeTokenClaims(tokens.access_token);
            await initUserDb(claims.sub, tokens);
            await bootstrapLocalIdentity(claims);
            loginToSurrealDB(tokens);
            setOfflineMode(false);
            send("authStateChanged", { state: getPublicAuthState() });
          })
          .catch((err) => {
            console.error("[auth] login failed:", err);
            send("authStateChanged", { state: { loggedIn: false, error: String(err) } });
          });
      },
    },
  };
}

function assertCanReadWorkspace(_workspaceId: string): void {
  assertAuthenticated();
}

function assertCanWriteWorkspace(workspaceId: string): void {
  assertWritable();
  assertCanReadWorkspace(workspaceId);
}
