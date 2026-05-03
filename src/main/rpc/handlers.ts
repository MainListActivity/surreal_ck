import type {
  AppBootstrap,
  AuthState,
  CreateBlankWorkbookRequest,
  CreateBlankWorkbookResponse,
  CreateDashboardPageRequest,
  CreateDashboardPageResponse,
  CreateDashboardViewRequest,
  CreateDashboardViewResponse,
  CreateFolderRequest,
  CreateFolderResponse,
  CreateSheetRequest,
  CreateSheetResponse,
  CreateWorkbookFromTemplateRequest,
  CreateWorkbookFromTemplateResponse,
  DeleteRowsRequest,
  DeleteRowsResponse,
  GetDashboardPageRequest,
  GetDashboardPageResponse,
  GetWorkbookDataRequest,
  GetWorkbookDataResponse,
  ListDashboardPagesRequest,
  ListDashboardPagesResponse,
  ListDashboardViewsRequest,
  ListDashboardViewsResponse,
  ListFoldersRequest,
  ListFoldersResponse,
  ListTemplatesResponse,
  ListWorkbooksRequest,
  ListWorkbooksResponse,
  MoveFolderRequest,
  MoveFolderResponse,
  MoveWorkbookRequest,
  MoveWorkbookResponse,
  RawQueryRequest,
  RawQueryResponse,
  RefreshDashboardPageRequest,
  RefreshDashboardPageResponse,
  RefreshDashboardViewRequest,
  RefreshDashboardViewResponse,
  RenameSheetRequest,
  RenameSheetResponse,
  RenameWorkbookRequest,
  RenameWorkbookResponse,
  ResolveReferencesRequest,
  ResolveReferencesResponse,
  Result,
  ListReferenceTargetsResponse,
  SaveDashboardPageLayoutRequest,
  SaveDashboardPageLayoutResponse,
  SearchReferenceCandidatesRequest,
  SearchReferenceCandidatesResponse,
  PreviewDashboardViewRequest,
  PreviewDashboardViewResponse,
  UpdateDashboardViewRequest,
  UpdateDashboardViewResponse,
  UpdateSheetFieldsRequest,
  UpdateSheetFieldsResponse,
  UpsertRowsRequest,
  UpsertRowsResponse,
} from "../../shared/rpc.types";
import { getServiceContext, setOfflineMode, assertAuthenticated } from "../services/context";
import { withResult, ServiceError } from "../services/errors";
import { getLocalDb } from "../db/index";
import { startOidcLogin } from "../auth/oidc";
import { loginToSurrealDB, clearSession, getPublicAuthState } from "../auth/session";
import { initUserDb, closeUserDb } from "../db/index";
import { decodeTokenClaims, bootstrapLocalIdentity } from "../services/identity";
import { listWorkbooks, createBlankWorkbook, moveWorkbook } from "../services/workbooks";
import { listFolders, createFolder, moveFolder } from "../services/folders";
import { listTemplates, createWorkbookFromTemplate } from "../services/templates";
import { getWorkbookData, upsertRows, deleteRows, renameWorkbook, updateSheetFields, createSheet, renameSheet } from "../services/editor";
import { listReferenceTargets, resolveReferences, searchReferenceCandidates } from "../services/references";
import {
  createDashboardPage,
  createDashboardView,
  getDashboardPage,
  listDashboardPages,
  listDashboardViews,
  previewDashboardDraft,
  refreshDashboardPage,
  refreshDashboardView,
  saveDashboardPageLayout,
  updateDashboardView,
} from "../services/dashboards";

type SendFn = (event: "authStateChanged", payload: { state: AuthState }) => void;

const ADMIN_QUERY_ENABLED =
  process.env.ADMIN_QUERY === "1" ||
  process.env.NODE_ENV === "development" ||
  process.env.BUN_ENV === "development";

/** 创建供 BrowserView.defineRPC handlers 字段消费的处理器对象。 */
export function createRpcHandlers(send: SendFn) {
  return {
    requests: {
      // ── 调试入口（Admin Console 专用）──────────────────────────────────
      query: async ({ sql }: RawQueryRequest): Promise<RawQueryResponse> => {
        if (!ADMIN_QUERY_ENABLED) {
          throw new ServiceError("FORBIDDEN", "raw query 仅在开发/管理员模式可用");
        }
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
            return {
              auth: getPublicAuthState(ctx.isOffline ? { offlineMode: true } : undefined),
              readOnly: true,
            } satisfies AppBootstrap;
          }

          const db = getLocalDb();
          const userRows = await db.query<
            [{ id: unknown; subject: string; email?: string; name?: string; display_name?: string; avatar?: string }[]]
          >(`SELECT id, subject, email, name, display_name, avatar FROM app_user LIMIT 1`);
          const userRow = userRows[0]?.[0];

          if (!userRow) throw new ServiceError("BOOTSTRAP_REQUIRED");

          const wsRows = await db.query<[{ id: unknown; name: string; slug: string }[]]>(
            `SELECT id, name, slug FROM workspace WHERE owner = $userId LIMIT 1`,
            { userId: userRow.id }
          );
          const wsRow = wsRows[0]?.[0];
          if (!wsRow) throw new ServiceError("BOOTSTRAP_REQUIRED");

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

      listWorkbooks: async (req: ListWorkbooksRequest): Promise<Result<ListWorkbooksResponse>> => {
        return withResult(() => {
          assertAuthenticated();
          return listWorkbooks(req);
        });
      },

      createBlankWorkbook: async (req: CreateBlankWorkbookRequest): Promise<Result<CreateBlankWorkbookResponse>> => {
        return withResult(() => createBlankWorkbook(req));
      },

      listFolders: async (req: ListFoldersRequest): Promise<Result<ListFoldersResponse>> => {
        return withResult(() => {
          assertAuthenticated();
          return listFolders(req);
        });
      },

      createFolder: async (req: CreateFolderRequest): Promise<Result<CreateFolderResponse>> => {
        return withResult(() => createFolder(req));
      },

      moveFolder: async (req: MoveFolderRequest): Promise<Result<MoveFolderResponse>> => {
        return withResult(() => moveFolder(req));
      },

      moveWorkbook: async (req: MoveWorkbookRequest): Promise<Result<MoveWorkbookResponse>> => {
        return withResult(() => moveWorkbook(req));
      },

      listTemplates: async (): Promise<Result<ListTemplatesResponse>> => {
        return withResult(async () => listTemplates());
      },

      createWorkbookFromTemplate: async (req: CreateWorkbookFromTemplateRequest): Promise<Result<CreateWorkbookFromTemplateResponse>> => {
        return withResult(() => createWorkbookFromTemplate(req));
      },

      getWorkbookData: async (req: GetWorkbookDataRequest): Promise<Result<GetWorkbookDataResponse>> => {
        return withResult(() => {
          assertAuthenticated();
          return getWorkbookData(req);
        });
      },

      upsertRows: async (req: UpsertRowsRequest): Promise<Result<UpsertRowsResponse>> => {
        return withResult(() => upsertRows(req));
      },

      deleteRows: async (req: DeleteRowsRequest): Promise<Result<DeleteRowsResponse>> => {
        return withResult(() => deleteRows(req));
      },

      renameWorkbook: async (req: RenameWorkbookRequest): Promise<Result<RenameWorkbookResponse>> => {
        return withResult(() => renameWorkbook(req));
      },

      updateSheetFields: async (req: UpdateSheetFieldsRequest): Promise<Result<UpdateSheetFieldsResponse>> => {
        return withResult(() => updateSheetFields(req));
      },

      createSheet: async (req: CreateSheetRequest): Promise<Result<CreateSheetResponse>> => {
        return withResult(() => createSheet(req));
      },

      renameSheet: async (req: RenameSheetRequest): Promise<Result<RenameSheetResponse>> => {
        return withResult(() => renameSheet(req));
      },

      resolveReferences: async (req: ResolveReferencesRequest): Promise<Result<ResolveReferencesResponse>> => {
        return withResult(() => {
          assertAuthenticated();
          return resolveReferences(req);
        });
      },

      listReferenceTargets: async (): Promise<Result<ListReferenceTargetsResponse>> => {
        return withResult(() => {
          assertAuthenticated();
          return listReferenceTargets();
        });
      },

      searchReferenceCandidates: async (req: SearchReferenceCandidatesRequest): Promise<Result<SearchReferenceCandidatesResponse>> => {
        return withResult(() => {
          assertAuthenticated();
          return searchReferenceCandidates(req);
        });
      },

      listDashboardPages: async (req: ListDashboardPagesRequest): Promise<Result<ListDashboardPagesResponse>> => {
        return withResult(() => {
          assertAuthenticated();
          return listDashboardPages(req);
        });
      },

      getDashboardPage: async (req: GetDashboardPageRequest): Promise<Result<GetDashboardPageResponse>> => {
        return withResult(() => {
          assertAuthenticated();
          return getDashboardPage(req);
        });
      },

      createDashboardPage: async (req: CreateDashboardPageRequest): Promise<Result<CreateDashboardPageResponse>> => {
        return withResult(() => createDashboardPage(req));
      },

      saveDashboardPageLayout: async (req: SaveDashboardPageLayoutRequest): Promise<Result<SaveDashboardPageLayoutResponse>> => {
        return withResult(() => saveDashboardPageLayout(req));
      },

      listDashboardViews: async (req: ListDashboardViewsRequest): Promise<Result<ListDashboardViewsResponse>> => {
        return withResult(() => {
          assertAuthenticated();
          return listDashboardViews(req);
        });
      },

      createDashboardView: async (req: CreateDashboardViewRequest): Promise<Result<CreateDashboardViewResponse>> => {
        return withResult(() => createDashboardView(req));
      },

      updateDashboardView: async (req: UpdateDashboardViewRequest): Promise<Result<UpdateDashboardViewResponse>> => {
        return withResult(() => updateDashboardView(req));
      },

      previewDashboardView: async (req: PreviewDashboardViewRequest): Promise<Result<PreviewDashboardViewResponse>> => {
        return withResult(() => previewDashboardDraft(req.draft));
      },

      refreshDashboardView: async (req: RefreshDashboardViewRequest): Promise<Result<RefreshDashboardViewResponse>> => {
        return withResult(() => refreshDashboardView(req));
      },

      refreshDashboardPage: async (req: RefreshDashboardPageRequest): Promise<Result<RefreshDashboardPageResponse>> => {
        return withResult(() => refreshDashboardPage(req));
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
