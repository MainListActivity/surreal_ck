import type {
  AiMessageChunkEvent,
  AiProgressEvent,
  AiRunCancelledEvent,
  AppBootstrap,
  AuthState,
  CancelAiWorkflowRequest,
  CancelAiWorkflowResponse,
  CancelResearchSessionRequest,
  CompleteResearchSessionRequest,
  CreateBlankWorkbookRequest,
  CreateBlankWorkbookResponse,
  CreateDashboardPageRequest,
  CreateDashboardPageResponse,
  CreateDashboardViewRequest,
  CreateDashboardViewResponse,
  CreateFolderRequest,
  CreateFolderResponse,
  CreateResearchSessionRequest,
  DeadLetterIdRequest,
  CreateSheetRequest,
  CreateSheetResponse,
  CreateWorkbookFromTemplateRequest,
  CreateWorkbookFromTemplateResponse,
  DeleteRowsRequest,
  DeleteRowsResponse,
  ExecuteAiActionRequest,
  ExecuteAiActionResponse,
  GetDashboardPageRequest,
  GetDashboardPageResponse,
  GenerateResourceDraftRequest,
  GenerateResourceDraftResponse,
  GetResearchSessionRequest,
  GetResourceDetailRequest,
  GetWorkbookDataRequest,
  GetWorkbookDataResponse,
  ListDashboardPagesRequest,
  ListDashboardPagesResponse,
  ListDashboardViewsRequest,
  ListDashboardViewsResponse,
  ListDeadLettersRequest,
  ListDeadLettersResponse,
  ListFoldersRequest,
  ListFoldersResponse,
  ListTemplatesResponse,
  ListWorkbooksRequest,
  ListWorkbooksResponse,
  MoveFolderRequest,
  MoveFolderResponse,
  MoveWorkbookRequest,
  MoveWorkbookResponse,
  OpenResearchWindowRequest,
  OpenResearchWindowResponse,
  RawQueryRequest,
  RawQueryResponse,
  RefreshDashboardPageRequest,
  RefreshDashboardPageResponse,
  RefreshDashboardViewRequest,
  RefreshDashboardViewResponse,
  RenameDashboardPageRequest,
  RenameDashboardPageResponse,
  RenameSheetRequest,
  RenameSheetResponse,
  RenameWorkbookRequest,
  RenameWorkbookResponse,
  ResolveReferencesRequest,
  ResolveReferencesResponse,
  RetryResourceEmbeddingRequest,
  RetryResourceEmbeddingResponse,
  ResumeAiWorkflowRequest,
  ResumeAiWorkflowResponse,
  ResearchSessionResponse,
  ResourceDetailResponse,
  Result,
  SaveResourceRequest,
  SaveResourceResponse,
  WorkflowSuspendedEvent,
  GetTableSchemaRequest,
  GetTableSchemaResponse,
  ListReferenceTargetsResponse,
  SaveDashboardPageLayoutRequest,
  SaveDashboardPageLayoutResponse,
  SaveResearchResourceRequest,
  SaveSettingsRequest,
  SaveSettingsResponse,
  SearchResourcesRequest,
  SearchResourcesResponse,
  SearchReferenceCandidatesRequest,
  SearchReferenceCandidatesResponse,
  SendAiMessageRequest,
  SendAiMessageResponse,
  SyncStatusDTO,
  SyncStatusV2DTO,
  ReconnectRemoteResponse,
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
import { initUserDb, closeUserDb, connectRemote } from "../db/index";
import { initMastraForCurrentUser, resetMastra } from "../ai/index";
import { decodeTokenClaims, bootstrapLocalIdentity } from "../services/identity";
import { listWorkbooks, createBlankWorkbook, moveWorkbook } from "../services/workbooks";
import { listFolders, createFolder, moveFolder } from "../services/folders";
import { listTemplates, createWorkbookFromTemplate } from "../services/templates";
import { getWorkbookData, upsertRows, deleteRows, renameWorkbook, updateSheetFields, createSheet, renameSheet } from "../services/editor";
import { listReferenceTargets, resolveReferences, searchReferenceCandidates } from "../services/references";
import { getTableSchema } from "../services/table-schema";
import {
  createDashboardPage,
  createDashboardView,
  getDashboardPage,
  listDashboardPages,
  listDashboardViews,
  previewDashboardDraft,
  refreshDashboardPage,
  refreshDashboardView,
  renameDashboardPage,
  saveDashboardPageLayout,
  updateDashboardView,
} from "../services/dashboards";
import {
  cancelResearchSession,
  completeResearchSession,
  createResearchSession,
  getResearchSession,
  getResourceDetail,
  retryResourceEmbedding,
  saveResearchResource,
  saveResource,
  searchResources,
} from "../services/resources";
import { openResearchWindow } from "../services/research-window";
import {
  getAiSettings,
  getEmbeddingSettings,
  getObservabilitySettings,
  saveAiSettings,
  saveEmbeddingSettings,
  saveObservabilitySettings,
  toAiSettingsDTO,
  toEmbeddingSettingsDTO,
} from "../services/settings";
import { sendAiMessage } from "../services/ai-chat";
import { resumeAiWorkflowFromRpc } from "../services/ai-resume-rpc";
import { cancelAiWorkflow } from "../services/ai-cancel";
import { executeAiAction } from "../services/ai-actions";
import { discardSyncDeadLetter, forceReapplySyncDeadLetter, getSyncStatus, listDeadLetters } from "../services/sync-state";
import { getSyncStatusV2, triggerSyncRebuild } from "../services/sync-state-v2";
import { reconnectNow } from "../services/reconnect-scheduler";
import { createResourceDraftFromEvidence } from "../ai/mastra/agents/resource-agent";

type SendFn = {
  (event: "authStateChanged", payload: { state: AuthState }): void;
  (event: "aiMessageChunk", payload: AiMessageChunkEvent): void;
  (event: "aiProgress", payload: AiProgressEvent): void;
  (event: "aiSuspended", payload: WorkflowSuspendedEvent): void;
  (event: "aiRunCancelled", payload: AiRunCancelledEvent): void;
};

export type WindowControlDeps = {
  toggleWindowMaximized(): void;
};

const ADMIN_QUERY_ENABLED =
  process.env.ADMIN_QUERY === "1" ||
  process.env.NODE_ENV === "development" ||
  process.env.BUN_ENV === "development";

/** 创建供 BrowserView.defineRPC handlers 字段消费的处理器对象。 */
export function createRpcHandlers(send: SendFn, windowControls?: WindowControlDeps) {
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
        resetMastra();
        clearSession();
        setOfflineMode(false);
        await closeUserDb();
        const state = getPublicAuthState();
        send("authStateChanged", { state });
      },

      toggleWindowMaximized: async (): Promise<void> => {
        windowControls?.toggleWindowMaximized();
      },

      // ── 产品 API ───────────────────────────────────────────────────────

      getAppBootstrap: async (): Promise<Result<AppBootstrap>> => {
        return withResult(async () => {
          const ctx = getServiceContext();

          if (!ctx.isAuthenticated) {
            return {
              auth: getPublicAuthState(ctx.isOffline ? { offlineMode: true } : undefined),
              capabilities: ctx.capabilities,
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
            capabilities: ctx.capabilities,
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

      getSyncStatus: async (): Promise<Result<SyncStatusDTO>> => {
        return withResult(() => getSyncStatus());
      },

      getSyncStatusV2: async (): Promise<Result<SyncStatusV2DTO>> => {
        return withResult(async () => getSyncStatusV2());
      },

      triggerSyncRebuild: async (): Promise<Result<SyncStatusV2DTO>> => {
        return withResult(() => triggerSyncRebuild());
      },

      reconnectRemote: async (): Promise<Result<ReconnectRemoteResponse>> => {
        return withResult(async () => {
          // 调度器立即触发一次重连（内部已调用 reconnectRemote 服务）；
          // 失败时会自动 schedule 下一次退避；needs-relogin 则停止。
          await reconnectNow();
          const sync = getSyncStatusV2();
          if (sync.online) {
            const state = getPublicAuthState();
            send("authStateChanged", { state });
            return { status: "reconnected", sync } satisfies ReconnectRemoteResponse;
          }
          if (sync.needsRelogin) {
            return {
              status: "needs-relogin",
              message: sync.lastError ?? "refresh_token 已失效，请重新登录",
              sync,
            } satisfies ReconnectRemoteResponse;
          }
          return {
            status: "offline",
            message: sync.lastError ?? "远端连接失败",
            sync,
          } satisfies ReconnectRemoteResponse;
        });
      },

      listDeadLetters: async (req: ListDeadLettersRequest): Promise<Result<ListDeadLettersResponse>> => {
        return withResult(() => listDeadLetters(req));
      },

      discardDeadLetter: async (req: DeadLetterIdRequest): Promise<Result<void>> => {
        return withResult(() => discardSyncDeadLetter(req.id));
      },

      forceReapplyDeadLetter: async (req: DeadLetterIdRequest): Promise<Result<void>> => {
        return withResult(() => forceReapplySyncDeadLetter(req.id));
      },

      getSettings: async (): Promise<Result<SaveSettingsResponse>> => {
        return withResult(async () => {
          assertAuthenticated();
          return {
            ai: toAiSettingsDTO(await getAiSettings()),
            embedding: toEmbeddingSettingsDTO(await getEmbeddingSettings()),
            observability: await getObservabilitySettings(),
          };
        });
      },

      saveSettings: async (req: SaveSettingsRequest): Promise<Result<SaveSettingsResponse>> => {
        return withResult(async () => {
          assertAuthenticated();
          const embedding = req.embedding
            ? await saveEmbeddingSettings(req.embedding)
            : await getEmbeddingSettings();
          return {
            ai: toAiSettingsDTO(await saveAiSettings(req.ai)),
            embedding: toEmbeddingSettingsDTO(embedding),
            observability: await saveObservabilitySettings(req.observability),
          };
        });
      },

      sendAiMessage: async (req: SendAiMessageRequest): Promise<Result<SendAiMessageResponse>> => {
        return withResult(() =>
          sendAiMessage(
            req,
            (event) => send("aiMessageChunk", event),
            (event) => send("aiProgress", event),
            (event) => send("aiSuspended", event),
          ),
        );
      },

      resumeAiWorkflow: async (req: ResumeAiWorkflowRequest): Promise<Result<ResumeAiWorkflowResponse>> => {
        return withResult(() =>
          resumeAiWorkflowFromRpc(req, {
            pushChunk: (event) => send("aiMessageChunk", event),
            pushProgress: (event) => send("aiProgress", event),
            onSuspend: (event) => send("aiSuspended", event),
          }),
        );
      },

      cancelAiWorkflow: async (req: CancelAiWorkflowRequest): Promise<Result<CancelAiWorkflowResponse>> => {
        return withResult(async () => {
          const res = await cancelAiWorkflow(req);
          send("aiRunCancelled", res.event);
          return res;
        });
      },

      executeAiAction: async (req: ExecuteAiActionRequest): Promise<Result<ExecuteAiActionResponse>> => {
        return withResult(() => executeAiAction(req));
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

      getTableSchema: async (req: GetTableSchemaRequest): Promise<Result<GetTableSchemaResponse>> => {
        return withResult(() => {
          assertAuthenticated();
          return getTableSchema(req);
        });
      },

      saveResource: async (req: SaveResourceRequest): Promise<Result<SaveResourceResponse>> => {
        return withResult(() => saveResource(req));
      },

      saveResearchResource: async (req: SaveResearchResourceRequest): Promise<Result<SaveResourceResponse>> => {
        return withResult(() => saveResearchResource(req));
      },

      getResourceDetail: async (req: GetResourceDetailRequest): Promise<Result<ResourceDetailResponse>> => {
        return withResult(() => getResourceDetail(req));
      },

      searchResources: async (req: SearchResourcesRequest): Promise<Result<SearchResourcesResponse>> => {
        return withResult(() => searchResources(req));
      },

      createResearchSession: async (req: CreateResearchSessionRequest): Promise<Result<ResearchSessionResponse>> => {
        return withResult(() => createResearchSession(req));
      },

      getResearchSession: async (req: GetResearchSessionRequest): Promise<Result<ResearchSessionResponse>> => {
        return withResult(() => getResearchSession(req));
      },

      completeResearchSession: async (req: CompleteResearchSessionRequest): Promise<Result<ResearchSessionResponse>> => {
        return withResult(() => completeResearchSession(req));
      },

      cancelResearchSession: async (req: CancelResearchSessionRequest): Promise<Result<ResearchSessionResponse>> => {
        return withResult(() => cancelResearchSession(req));
      },

      retryResourceEmbedding: async (req: RetryResourceEmbeddingRequest): Promise<Result<RetryResourceEmbeddingResponse>> => {
        return withResult(() => retryResourceEmbedding(req));
      },

      openResearchWindow: async (req: OpenResearchWindowRequest): Promise<Result<OpenResearchWindowResponse>> => {
        return withResult(() => openResearchWindow(req));
      },

      generateResourceDraft: async (req: GenerateResourceDraftRequest): Promise<Result<GenerateResourceDraftResponse>> => {
        return withResult(async () => ({ draft: createResourceDraftFromEvidence(req) }));
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

      renameDashboardPage: async (req: RenameDashboardPageRequest): Promise<Result<RenameDashboardPageResponse>> => {
        return withResult(() => renameDashboardPage(req));
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
        return withResult(() => previewDashboardDraft(req.draft, { confirmRisk: req.confirmRisk }));
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
            await connectRemote(tokens.access_token);
            loginToSurrealDB(tokens);
            initMastraForCurrentUser();
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
