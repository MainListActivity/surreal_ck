import { rpc } from "./rpc";
import type { AppBootstrap, Result } from "../../shared/rpc.types";

/** 产品页面唯一的数据入口；不暴露 raw query。 */
export const appApi = {
  getAppBootstrap(): Promise<Result<AppBootstrap>> {
    return rpc.request("getAppBootstrap", {});
  },

  listWorkbooks(workspaceId: string): Promise<Result<unknown[]>> {
    return rpc.request("listWorkbooks", { workspaceId });
  },

  createBlankWorkbook(workspaceId: string, name: string): Promise<Result<unknown>> {
    return rpc.request("createBlankWorkbook", { workspaceId, name });
  },
};
