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
  GetDashboardPageResponse,
  GetWorkbookDataResponse,
  ListDashboardPagesResponse,
  ListDashboardViewsResponse,
  ListFoldersResponse,
  ListTemplatesResponse,
  ListWorkbooksResponse,
  GridColumnDef,
  ListReferenceTargetsResponse,
  MoveFolderResponse,
  MoveWorkbookResponse,
  RecordIdString,
  RefreshDashboardPageResponse,
  RefreshDashboardViewResponse,
  RenameSheetResponse,
  RenameWorkbookResponse,
  ResolveReferencesResponse,
  Result,
  SaveDashboardPageLayoutResponse,
  SearchReferenceCandidatesResponse,
  UpdateSheetFieldsResponse,
  UpdateDashboardViewResponse,
  UpsertRowsResponse,
  ViewParams,
} from "../../shared/rpc.types";

/** 产品页面唯一的数据入口；不暴露 raw query。 */
export const appApi = {
  getAppBootstrap(): Promise<Result<AppBootstrap>> {
    return rpc.request("getAppBootstrap", {});
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

  listDashboardPages(workspaceId: RecordIdString): Promise<Result<ListDashboardPagesResponse>> {
    return rpc.request("listDashboardPages", { workspaceId });
  },

  getDashboardPage(pageId: RecordIdString): Promise<Result<GetDashboardPageResponse>> {
    return rpc.request("getDashboardPage", { pageId });
  },

  createDashboardPage(
    workspaceId: RecordIdString,
    title: string,
    description?: string,
  ): Promise<Result<CreateDashboardPageResponse>> {
    return rpc.request("createDashboardPage", { workspaceId, title, description });
  },

  saveDashboardPageLayout(
    pageId: RecordIdString,
    widgets: DashboardWidgetLayoutDTO[],
  ): Promise<Result<SaveDashboardPageLayoutResponse>> {
    return rpc.request("saveDashboardPageLayout", { pageId, widgets });
  },

  listDashboardViews(workspaceId: RecordIdString): Promise<Result<ListDashboardViewsResponse>> {
    return rpc.request("listDashboardViews", { workspaceId });
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
