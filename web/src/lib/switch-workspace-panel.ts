import { createCreateEntryController } from "./create-entry";
import type {
  LoadWorkspacesResult,
  SwitchResult,
  WorkspaceListItem,
} from "./switch-workspace";

export type SwitchWorkspacePanelState = {
  open: boolean;
  dialogOpen: boolean;
  workspaces: WorkspaceListItem[];
  currentDbName: string | null;
  canCreate: boolean;
  switching: string | null;
  error: string | null;
};

export type SwitchWorkspacePanelDeps = {
  loadWorkspaces(): Promise<LoadWorkspacesResult>;
  switchWorkspace(slug: string): Promise<SwitchResult>;
  onCreated?: () => void;
};

export function initialSwitchWorkspacePanelState(): SwitchWorkspacePanelState {
  return {
    open: false,
    dialogOpen: false,
    workspaces: [],
    currentDbName: null,
    canCreate: false,
    switching: null,
    error: null,
  };
}

function applyLoaded(
  state: SwitchWorkspacePanelState,
  loaded: LoadWorkspacesResult,
): SwitchWorkspacePanelState {
  return {
    ...state,
    workspaces: loaded.workspaces,
    currentDbName: loaded.currentDbName,
    canCreate: loaded.canCreate,
  };
}

function errorMessage(result: Extract<SwitchResult, { ok: false }>): string {
  if (result.reason === "forbidden") return "无权访问该工作区";
  if (result.reason === "refresh-failed") return "会话已过期，请重新登录";
  return result.message ?? "切换失败";
}

function currentWorkspace(state: SwitchWorkspacePanelState): WorkspaceListItem | null {
  return state.workspaces.find((ws) => ws.dbName === state.currentDbName) ?? null;
}

export function createSwitchWorkspacePanelController(deps: SwitchWorkspacePanelDeps) {
  return {
    async reload(state: SwitchWorkspacePanelState): Promise<SwitchWorkspacePanelState> {
      const loaded = await deps.loadWorkspaces();
      return applyLoaded(state, loaded);
    },

    toggle(state: SwitchWorkspacePanelState): SwitchWorkspacePanelState {
      return { ...state, open: !state.open };
    },

    startCreate(state: SwitchWorkspacePanelState): SwitchWorkspacePanelState {
      const createEntry = createCreateEntryController({
        canCreate: () => state.canCreate,
        reload: async () => {},
        onCreated: deps.onCreated,
      });
      const next = createEntry.openDialog({
        dropdownOpen: state.open,
        dialogOpen: state.dialogOpen,
      });
      return { ...state, open: next.dropdownOpen, dialogOpen: next.dialogOpen };
    },

    cancelCreate(state: SwitchWorkspacePanelState): SwitchWorkspacePanelState {
      const createEntry = createCreateEntryController({
        canCreate: () => state.canCreate,
        reload: async () => {},
        onCreated: deps.onCreated,
      });
      const next = createEntry.closeDialog();
      return { ...state, open: next.dropdownOpen, dialogOpen: next.dialogOpen };
    },

    async handleCreated(
      state: SwitchWorkspacePanelState,
    ): Promise<SwitchWorkspacePanelState> {
      let reloaded = state;
      const createEntry = createCreateEntryController({
        canCreate: () => state.canCreate,
        reload: async () => {
          reloaded = applyLoaded(state, await deps.loadWorkspaces());
        },
        onCreated: deps.onCreated,
      });
      const next = await createEntry.handleCreated();
      return {
        ...reloaded,
        open: next.dropdownOpen,
        dialogOpen: next.dialogOpen,
        switching: null,
        error: null,
      };
    },

    async choose(
      state: SwitchWorkspacePanelState,
      slug: string,
    ): Promise<SwitchWorkspacePanelState> {
      if (currentWorkspace(state)?.slug === slug) {
        return { ...state, open: false, switching: null, error: null };
      }

      const switchingState = { ...state, switching: slug, error: null };
      const result = await deps.switchWorkspace(slug);

      if (!result.ok) {
        return {
          ...switchingState,
          switching: null,
          error: errorMessage(result),
        };
      }

      const loaded = await deps.loadWorkspaces();
      return applyLoaded(
        {
          ...switchingState,
          open: false,
          switching: null,
          error: null,
        },
        loaded,
      );
    },
  };
}
