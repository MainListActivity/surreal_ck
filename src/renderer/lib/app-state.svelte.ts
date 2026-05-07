import { appApi } from "./app-api";
import type { AppBootstrap, WorkspaceDTO, CurrentUserDTO } from "../../shared/rpc.types";

type AppState = {
  loading: boolean;
  error: string | null;
  bootstrap: AppBootstrap | null;
  user: CurrentUserDTO | null;
  workspace: WorkspaceDTO | null;
  readOnly: boolean;
  aiDrawerOpen: boolean;
};

function createAppState() {
  let state = $state<AppState>({
    loading: false,
    error: null,
    bootstrap: null,
    user: null,
    workspace: null,
    readOnly: false,
    aiDrawerOpen: false,
  });

  async function load() {
    state.loading = true;
    state.error = null;
    try {
      const result = await appApi.getAppBootstrap();
      if (result.ok) {
        state.bootstrap = result.data;
        state.user = result.data.user ?? null;
        state.workspace = result.data.defaultWorkspace ?? null;
        state.readOnly = result.data.readOnly;
      } else {
        state.error = result.message;
      }
    } catch (err) {
      state.error = String(err);
    } finally {
      state.loading = false;
    }
  }

  function reset() {
    state.loading = false;
    state.error = null;
    state.bootstrap = null;
    state.user = null;
    state.workspace = null;
    state.readOnly = false;
    state.aiDrawerOpen = false;
  }

  function toggleAiDrawer() {
    state.aiDrawerOpen = !state.aiDrawerOpen;
  }

  function setAiDrawerOpen(open: boolean) {
    state.aiDrawerOpen = open;
  }

  return {
    get loading() { return state.loading; },
    get error() { return state.error; },
    get bootstrap() { return state.bootstrap; },
    get user() { return state.user; },
    get workspace() { return state.workspace; },
    get readOnly() { return state.readOnly; },
    get aiDrawerOpen() { return state.aiDrawerOpen; },
    load,
    reset,
    toggleAiDrawer,
    setAiDrawerOpen,
  };
}

export const appState = createAppState();
