import { appApi } from "./app-api";
import type { WorkbookSummaryDTO, FolderDTO } from "../../shared/rpc.types";

type WorkbooksState = {
  loading: boolean;
  error: string | null;
  workbooks: WorkbookSummaryDTO[];
  folders: FolderDTO[];
  workspaceId: string | null;
};

function createWorkbooksStore() {
  let state = $state<WorkbooksState>({
    loading: false,
    error: null,
    workbooks: [],
    folders: [],
    workspaceId: null,
  });

  async function loadForWorkspace(workspaceId: string) {
    if (!workspaceId) return;
    state.workspaceId = workspaceId;
    state.loading = true;
    state.error = null;
    try {
      const [wbRes, folderRes] = await Promise.all([
        appApi.listWorkbooks(workspaceId),
        appApi.listFolders(workspaceId),
      ]);
      if (wbRes.ok) state.workbooks = wbRes.data.workbooks;
      else state.error = wbRes.message;
      if (folderRes.ok) state.folders = folderRes.data.folders;
    } catch (err) {
      state.error = String(err);
    } finally {
      state.loading = false;
    }
  }

  async function createBlank(
    workspaceId: string,
    name: string,
    folderId?: string | null
  ): Promise<WorkbookSummaryDTO | null> {
    const res = await appApi.createBlankWorkbook(workspaceId, name, folderId);
    if (res.ok) {
      state.workbooks = [res.data.workbook, ...state.workbooks];
      return res.data.workbook;
    }
    state.error = res.message;
    return null;
  }

  async function createFromTemplate(workspaceId: string, templateKey: string, name?: string): Promise<WorkbookSummaryDTO | null> {
    const res = await appApi.createWorkbookFromTemplate(workspaceId, templateKey, name);
    if (res.ok) {
      state.workbooks = [res.data.workbook, ...state.workbooks];
      return res.data.workbook;
    }
    state.error = res.message;
    return null;
  }

  function filterByQuery(query: string): WorkbookSummaryDTO[] {
    if (!query) return state.workbooks;
    const q = query.toLowerCase();
    return state.workbooks.filter(
      (wb) =>
        wb.name.toLowerCase().includes(q) ||
        (wb.templateKey ?? "").toLowerCase().includes(q)
    );
  }

  function filterByFolder(folderId: string | null): WorkbookSummaryDTO[] {
    if (!folderId) return state.workbooks.filter((wb) => !wb.folderId);
    return state.workbooks.filter((wb) => wb.folderId === folderId);
  }

  return {
    get loading() { return state.loading; },
    get error() { return state.error; },
    get workbooks() { return state.workbooks; },
    get folders() { return state.folders; },
    loadForWorkspace,
    createBlank,
    createFromTemplate,
    filterByQuery,
    filterByFolder,
  };
}

export const workbooksStore = createWorkbooksStore();
