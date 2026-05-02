import { rpc } from "./rpc";
import type {
  AppBootstrap,
  CreateBlankWorkbookResponse,
  CreateFolderResponse,
  CreateSheetResponse,
  CreateWorkbookFromTemplateResponse,
  DeleteRowsResponse,
  GetWorkbookDataResponse,
  ListFoldersResponse,
  ListTemplatesResponse,
  ListWorkbooksResponse,
  GridColumnDef,
  MoveFolderResponse,
  MoveWorkbookResponse,
  RecordIdString,
  RenameSheetResponse,
  RenameWorkbookResponse,
  Result,
  UpdateSheetFieldsResponse,
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
};
