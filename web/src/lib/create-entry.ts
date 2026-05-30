/**
 * 05a — workspace 下拉菜单「新建工作区」入口的纯逻辑层（单测覆盖）。
 *
 * 把创建入口收敛到 WorkspaceSwitcher 内部：dropdown 是否显示入口由 canCreate 决定，
 * 点击入口关下拉并打开 D2-06 的创建对话框，创建成功后 reload 列表并通知。
 * 这样无论谁挂 WorkspaceSwitcher（SideNav / 未来顶栏），创建逻辑只有一份。
 */
export type CreateEntryDeps = {
  /** 是否有创建 workspace 权限（来自后端 listWorkspaces 返回的 canCreate）。 */
  canCreate: () => boolean;
  /** 创建成功后重载 workspace 列表（使新 workspace 出现并标记为当前）。 */
  reload: () => Promise<void>;
  /** 创建成功后的可选外部通知（公共 seam，供 shell 关掉自己的态等）。 */
  onCreated?: () => void;
};

/** 入口的可见状态：下拉是否展开、对话框是否打开。 */
export type CreateEntryState = {
  dropdownOpen: boolean;
  dialogOpen: boolean;
};

export function createCreateEntryController(deps: CreateEntryDeps) {
  return {
    /** dropdown 是否显示「新建工作区」入口。 */
    showEntry(): boolean {
      return deps.canCreate();
    },

    /** 点击入口：有权限则关下拉、开对话框；无权限忽略。 */
    openDialog(state: CreateEntryState): CreateEntryState {
      if (!deps.canCreate()) return state;
      return { dropdownOpen: false, dialogOpen: true };
    },

    /** 取消创建：只关对话框，不 reload、不通知。 */
    closeDialog(): CreateEntryState {
      return { dropdownOpen: false, dialogOpen: false };
    },

    /** 创建成功：reload 列表 + 通知 + 关对话框。 */
    async handleCreated(): Promise<CreateEntryState> {
      await deps.reload();
      deps.onCreated?.();
      return { dropdownOpen: false, dialogOpen: false };
    },
  };
}
