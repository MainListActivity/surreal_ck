import { rpc } from "./rpc";
import type {
  AppBootstrap,
  CreateBlankWorkbookResponse,
  CreateDashboardPageResponse,
  CreateDashboardViewResponse,
  CreateFolderResponse,
  CreateSheetResponse,
  CreateWorkbookFromTemplateResponse,
  DashboardPageSummaryDTO,
  DashboardPreviewResponse,
  DashboardViewDraftDTO,
  DashboardViewSummaryDTO,
  DashboardWidgetLayoutDTO,
  DeleteRowsResponse,
  ExecuteAiActionResponse,
  GetDashboardPageResponse,
  GetSettingsResponse,
  GenerateResourceDraftRequest,
  GenerateResourceDraftResponse,
  GetWorkbookDataResponse,
  ListDashboardPagesResponse,
  ListDashboardViewsResponse,
  ListFoldersResponse,
  ListTemplatesResponse,
  ListWorkbooksResponse,
  GetTableSchemaResponse,
  GridColumnDef,
  ListDeadLettersResponse,
  ListReferenceTargetsResponse,
  MoveFolderResponse,
  MoveWorkbookResponse,
  OpenResearchWindowRequest,
  OpenResearchWindowResponse,
  RecordIdString,
  RefreshDashboardPageResponse,
  RefreshDashboardViewResponse,
  RenameDashboardPageResponse,
  RenameSheetResponse,
  RenameWorkbookResponse,
  ResolveReferencesResponse,
  Result,
  SyncStatusDTO,
  SyncStatusV2DTO,
  ReconnectRemoteResponse,
  RetryResourceEmbeddingResponse,
  SaveDashboardPageLayoutResponse,
  SaveSettingsResponse,
  SearchReferenceCandidatesResponse,
  SendAiMessageResponse,
  SendAiMessageRequest,
  ResumeAiWorkflowResponse,
  ResumeDecision,
  AiStructuredIntent,
  CancelAiWorkflowRequest,
  CancelAiWorkflowResponse,
  CancelResearchSessionRequest,
  CompleteResearchSessionRequest,
  ToolNavigationIntent,
  CreateResearchSessionRequest,
  GetResearchSessionRequest,
  GetResourceDetailRequest,
  ResearchSessionResponse,
  ResourceDetailResponse,
  SaveResourceRequest,
  SaveResourceResponse,
  SaveResearchResourceRequest,
  SearchResourcesRequest,
  SearchResourcesResponse,
  UpdateSheetFieldsResponse,
  UpdateDashboardViewResponse,
  UpsertRowsResponse,
  ViewParams,
} from "../../shared/rpc.types";
import type { AiChatMessage } from "../../shared/ai-context";

/** 产品页面唯一的数据入口；不暴露 raw query。 */
export const appApi = {
  getAppBootstrap(): Promise<Result<AppBootstrap>> {
    return rpc.request("getAppBootstrap", {});
  },

  getSyncStatus(): Promise<Result<SyncStatusDTO>> {
    return rpc.request("getSyncStatus", {});
  },

  getSyncStatusV2(): Promise<Result<SyncStatusV2DTO>> {
    return rpc.request("getSyncStatusV2", {});
  },

  triggerSyncRebuild(): Promise<Result<SyncStatusV2DTO>> {
    return rpc.request("triggerSyncRebuild", {});
  },

  reconnectRemote(): Promise<Result<ReconnectRemoteResponse>> {
    return rpc.request("reconnectRemote", {});
  },

  listDeadLetters(options: { limit?: number; offset?: number } = {}): Promise<Result<ListDeadLettersResponse>> {
    return rpc.request("listDeadLetters", options);
  },

  discardDeadLetter(id: string): Promise<Result<void>> {
    return rpc.request("discardDeadLetter", { id });
  },

  forceReapplyDeadLetter(id: string): Promise<Result<void>> {
    return rpc.request("forceReapplyDeadLetter", { id });
  },

  getSettings(): Promise<Result<GetSettingsResponse>> {
    return rpc.request("getSettings", {});
  },

  saveSettings(settings: {
    retentionDays: number;
    ai: {
      provider: "openai" | "anthropic" | "google" | "custom";
      model: string;
      baseUrl?: string;
      apiFormat: "openai-compatible" | "openai-responses" | "anthropic";
      apiKey?: string;
      clearApiKey?: boolean;
    };
    embedding?: {
      provider: "openai" | "anthropic" | "google" | "custom";
      model: string;
      dimensions: number;
      version: string;
      baseUrl?: string;
      apiFormat: "openai-compatible" | "openai-responses" | "anthropic";
      apiKey?: string;
      clearApiKey?: boolean;
    };
  }): Promise<Result<SaveSettingsResponse>> {
    return rpc.request("saveSettings", {
      ai: settings.ai,
      ...(settings.embedding ? { embedding: settings.embedding } : {}),
      observability: { retentionDays: settings.retentionDays },
    });
  },

  sendAiMessage(
    message: AiChatMessage,
    streamId: string,
    history?: AiChatMessage[],
    options: Pick<SendAiMessageRequest, "composerMode"> = {},
  ): Promise<Result<SendAiMessageResponse>> {
    return rpc.request("sendAiMessage", { message, streamId, history, ...options });
  },

  resumeAiWorkflow(runId: string, decision: ResumeDecision): Promise<Result<ResumeAiWorkflowResponse>> {
    return rpc.request("resumeAiWorkflow", { runId, decision });
  },

  cancelAiWorkflow(req: CancelAiWorkflowRequest): Promise<Result<CancelAiWorkflowResponse>> {
    return rpc.request("cancelAiWorkflow", req);
  },

  executeAiAction(
    intent: ToolNavigationIntent | AiStructuredIntent,
    options?: { runId?: string; workflowName?: string },
  ): Promise<Result<ExecuteAiActionResponse>> {
    return rpc.request("executeAiAction", { intent, ...options });
  },

  listWorkbooks(
    workspaceId: RecordIdString,
    options?: { folderId?: RecordIdString | null; search?: string }
  ): Promise<Result<ListWorkbooksResponse>> {
    return rpc.request("listWorkbooks", { workspaceId, ...options });
  },

  createBlankWorkbook(
    workspaceId: RecordIdString,
    name: string,
    folderId?: RecordIdString | null
  ): Promise<Result<CreateBlankWorkbookResponse>> {
    return rpc.request("createBlankWorkbook", { workspaceId, name, folderId });
  },

  listFolders(workspaceId: RecordIdString): Promise<Result<ListFoldersResponse>> {
    return rpc.request("listFolders", { workspaceId });
  },

  createFolder(workspaceId: RecordIdString, name: string, parentId?: RecordIdString): Promise<Result<CreateFolderResponse>> {
    return rpc.request("createFolder", { workspaceId, name, parentId });
  },

  moveFolder(folderId: RecordIdString, parentId: RecordIdString | null): Promise<Result<MoveFolderResponse>> {
    return rpc.request("moveFolder", { folderId, parentId });
  },

  moveWorkbook(workbookId: RecordIdString, folderId: RecordIdString | null): Promise<Result<MoveWorkbookResponse>> {
    return rpc.request("moveWorkbook", { workbookId, folderId });
  },

  listTemplates(): Promise<Result<ListTemplatesResponse>> {
    return rpc.request("listTemplates", {});
  },

  createWorkbookFromTemplate(workspaceId: RecordIdString, templateKey: string, name?: string): Promise<Result<CreateWorkbookFromTemplateResponse>> {
    return rpc.request("createWorkbookFromTemplate", { workspaceId, templateKey, name });
  },

  getWorkbookData(
    workbookId: RecordIdString,
    sheetId?: RecordIdString,
    viewParams?: ViewParams,
  ): Promise<Result<GetWorkbookDataResponse>> {
    return rpc.request("getWorkbookData", { workbookId, sheetId, viewParams });
  },

  upsertRows(
    sheetId: RecordIdString,
    rows: Array<{ id?: RecordIdString; values: Record<string, unknown> }>
  ): Promise<Result<UpsertRowsResponse>> {
    return rpc.request("upsertRows", { sheetId, rows });
  },

  deleteRows(sheetId: RecordIdString, ids: RecordIdString[]): Promise<Result<DeleteRowsResponse>> {
    return rpc.request("deleteRows", { sheetId, ids });
  },

  renameWorkbook(workbookId: RecordIdString, name: string): Promise<Result<RenameWorkbookResponse>> {
    return rpc.request("renameWorkbook", { workbookId, name });
  },

  updateSheetFields(sheetId: RecordIdString, columns: GridColumnDef[]): Promise<Result<UpdateSheetFieldsResponse>> {
    return rpc.request("updateSheetFields", { sheetId, columns });
  },

  createSheet(workbookId: RecordIdString, label?: string): Promise<Result<CreateSheetResponse>> {
    return rpc.request("createSheet", { workbookId, label });
  },

  renameSheet(sheetId: RecordIdString, label: string): Promise<Result<RenameSheetResponse>> {
    return rpc.request("renameSheet", { sheetId, label });
  },

  resolveReferences(ids: RecordIdString[]): Promise<Result<ResolveReferencesResponse>> {
    return rpc.request("resolveReferences", { ids });
  },

  listReferenceTargets(): Promise<Result<ListReferenceTargetsResponse>> {
    return rpc.request("listReferenceTargets", {});
  },

  searchReferenceCandidates(
    table: string,
    options?: { query?: string; displayKey?: string; limit?: number },
  ): Promise<Result<SearchReferenceCandidatesResponse>> {
    return rpc.request("searchReferenceCandidates", { table, ...options });
  },

  getTableSchema(table: string): Promise<Result<GetTableSchemaResponse>> {
    return rpc.request("getTableSchema", { table });
  },

  saveResource(req: SaveResourceRequest): Promise<Result<SaveResourceResponse>> {
    return rpc.request("saveResource", req);
  },

  saveResearchResource(req: SaveResearchResourceRequest): Promise<Result<SaveResourceResponse>> {
    return rpc.request("saveResearchResource", req);
  },

  retryResourceEmbedding(resourceId: RecordIdString): Promise<Result<RetryResourceEmbeddingResponse>> {
    return rpc.request("retryResourceEmbedding", { resourceId });
  },

  getResourceDetail(req: GetResourceDetailRequest): Promise<Result<ResourceDetailResponse>> {
    return rpc.request("getResourceDetail", req);
  },

  searchResources(req: SearchResourcesRequest): Promise<Result<SearchResourcesResponse>> {
    return rpc.request("searchResources", req);
  },

  createResearchSession(req: CreateResearchSessionRequest): Promise<Result<ResearchSessionResponse>> {
    return rpc.request("createResearchSession", req);
  },

  getResearchSession(req: GetResearchSessionRequest): Promise<Result<ResearchSessionResponse>> {
    return rpc.request("getResearchSession", req);
  },

  completeResearchSession(req: CompleteResearchSessionRequest): Promise<Result<ResearchSessionResponse>> {
    return rpc.request("completeResearchSession", req);
  },

  cancelResearchSession(req: CancelResearchSessionRequest): Promise<Result<ResearchSessionResponse>> {
    return rpc.request("cancelResearchSession", req);
  },

  openResearchWindow(req: OpenResearchWindowRequest): Promise<Result<OpenResearchWindowResponse>> {
    return rpc.request("openResearchWindow", req);
  },

  generateResourceDraft(req: GenerateResourceDraftRequest): Promise<Result<GenerateResourceDraftResponse>> {
    return rpc.request("generateResourceDraft", req);
  },

  listDashboardPages(workspaceId: RecordIdString, workbookId?: RecordIdString): Promise<Result<ListDashboardPagesResponse>> {
    return rpc.request("listDashboardPages", { workspaceId, workbookId });
  },

  getDashboardPage(pageId: RecordIdString): Promise<Result<GetDashboardPageResponse>> {
    return rpc.request("getDashboardPage", { pageId });
  },

  createDashboardPage(
    workspaceId: RecordIdString,
    workbookId: RecordIdString | undefined,
    title: string,
    description?: string,
  ): Promise<Result<CreateDashboardPageResponse>> {
    return rpc.request("createDashboardPage", { workspaceId, workbookId, title, description });
  },

  renameDashboardPage(pageId: RecordIdString, title: string): Promise<Result<RenameDashboardPageResponse>> {
    return rpc.request("renameDashboardPage", { pageId, title });
  },

  saveDashboardPageLayout(
    pageId: RecordIdString,
    widgets: DashboardWidgetLayoutDTO[],
  ): Promise<Result<SaveDashboardPageLayoutResponse>> {
    return rpc.request("saveDashboardPageLayout", { pageId, widgets });
  },

  listDashboardViews(workspaceId: RecordIdString, workbookId?: RecordIdString): Promise<Result<ListDashboardViewsResponse>> {
    return rpc.request("listDashboardViews", { workspaceId, workbookId });
  },

  createDashboardView(draft: DashboardViewDraftDTO): Promise<Result<CreateDashboardViewResponse>> {
    return rpc.request("createDashboardView", { draft });
  },

  updateDashboardView(viewId: RecordIdString, draft: DashboardViewDraftDTO): Promise<Result<UpdateDashboardViewResponse>> {
    return rpc.request("updateDashboardView", { viewId, draft });
  },

  previewDashboardView(draft: DashboardViewDraftDTO): Promise<Result<DashboardPreviewResponse>> {
    return rpc.request("previewDashboardView", { draft });
  },

  refreshDashboardView(viewId: RecordIdString): Promise<Result<RefreshDashboardViewResponse>> {
    return rpc.request("refreshDashboardView", { viewId });
  },

  refreshDashboardPage(pageId: RecordIdString): Promise<Result<RefreshDashboardPageResponse>> {
    return rpc.request("refreshDashboardPage", { pageId });
  },
};
