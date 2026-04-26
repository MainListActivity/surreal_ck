import { rpc } from "./rpc";
import type {
  AppBootstrap,
  CreateBlankWorkbookResponse,
  ListWorkbooksResponse,
  RecordIdString,
  Result,
} from "../../shared/rpc.types";

/** 产品页面唯一的数据入口；不暴露 raw query。 */
export const appApi = {
  getAppBootstrap(): Promise<Result<AppBootstrap>> {
    return rpc.request("getAppBootstrap", {});
  },

  listWorkbooks(workspaceId: RecordIdString): Promise<Result<ListWorkbooksResponse>> {
    return rpc.request("listWorkbooks", { workspaceId });
  },

  createBlankWorkbook(workspaceId: RecordIdString, name: string): Promise<Result<CreateBlankWorkbookResponse>> {
    return rpc.request("createBlankWorkbook", { workspaceId, name });
  },
};
