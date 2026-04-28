import { rpc } from "./rpc";
import type {
  AppBootstrap,
  CreateBlankWorkbookResponse,
  CreateFolderResponse,
  CreateWorkbookFromTemplateResponse,
  DeleteRowsResponse,
  GetWorkbookDataResponse,
  ListFoldersResponse,
  ListTemplatesResponse,
  ListWorkbooksResponse,
  GridColumnDef,
  RecordIdString,
  RenameWorkbookResponse,
  Result,
  UpdateSheetFieldsResponse,
  UpsertRowsResponse,
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

  listTemplates(): Promise<Result<ListTemplatesResponse>> {
    return rpc.request("listTemplates", {});
  },

  createWorkbookFromTemplate(workspaceId: RecordIdString, templateKey: string, name?: string): Promise<Result<CreateWorkbookFromTemplateResponse>> {
    return rpc.request("createWorkbookFromTemplate", { workspaceId, templateKey, name });
  },

  getWorkbookData(workbookId: RecordIdString, sheetId?: RecordIdString): Promise<Result<GetWorkbookDataResponse>> {
    return rpc.request("getWorkbookData", { workbookId, sheetId });
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
};
