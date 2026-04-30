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

  async function createFolder(
    workspaceId: string,
    name: string,
    parentId?: string
  ): Promise<FolderDTO | null> {
    const res = await appApi.createFolder(workspaceId, name, parentId);
    if (res.ok) {
      state.folders = [...state.folders, res.data.folder];
      return res.data.folder;
    }
    state.error = res.message;
    return null;
  }

  /** 检查 candidate 是否是 folderId 的后代（含自身），用于阻止把目录移到自己的子树里。 */
  function isDescendantOrSelf(candidateId: string, folderId: string): boolean {
    if (candidateId === folderId) return true;
    let cursor: string | undefined = candidateId;
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const node = state.folders.find((f) => f.id === cursor);
      if (!node) return false;
      if (node.parentId === folderId) return true;
      cursor = node.parentId;
    }
    return false;
  }

  async function moveFolder(folderId: string, parentId: string | null): Promise<boolean> {
    if (parentId && isDescendantOrSelf(parentId, folderId)) {
      state.error = "不能将目录移动到自己的子目录下";
      return false;
    }
    const res = await appApi.moveFolder(folderId, parentId);
    if (res.ok) {
      state.folders = state.folders.map((f) =>
        f.id === folderId ? res.data.folder : f
      );
      return true;
    }
    state.error = res.message;
    return false;
  }

  async function moveWorkbook(workbookId: string, folderId: string | null): Promise<boolean> {
    const res = await appApi.moveWorkbook(workbookId, folderId);
    if (res.ok) {
      state.workbooks = state.workbooks.map((wb) =>
        wb.id === workbookId ? res.data.workbook : wb
      );
      return true;
    }
    state.error = res.message;
    return false;
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
    createFolder,
    moveFolder,
    moveWorkbook,
    filterByQuery,
    filterByFolder,
  };
}

export const workbooksStore = createWorkbooksStore();
