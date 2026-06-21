import type { SurrealConn, SurrealConnectInput } from "./surreal";

export type ConnectionState = "open" | "closing" | "closed";

export type CurrentUser = {
  subject?: string;
  email?: string;
  name?: string;
  /** 当前 workspace db 里 user.display_name 的镜像；个人中心保存后回写，侧栏据此刷新。 */
  displayName?: string | null;
};

export type CurrentWorkspace = {
  /** Filled by the Workspace Scope Module (issue 05); token only carries the db. */
  slug?: string;
  name?: string;
  dbName: string;
  role?: string;
};

export type EnterWorkspaceInput = {
  rawToken: string;
  dbName: string;
  user?: CurrentUser;
  role?: string;
  slug?: string;
  name?: string;
};

export type WorkspaceSnapshot = {
  currentUser: CurrentUser | null;
  currentWorkspace: CurrentWorkspace | null;
  connectionState: ConnectionState;
};

export type WorkspaceStateOptions = {
  surrealUrl: string;
  namespace: string;
  connect: (input: SurrealConnectInput) => Promise<SurrealConn>;
  /** Notified after any field changes, so a reactive (runes) layer can mirror it. */
  onChange?: (snapshot: WorkspaceSnapshot) => void;
};

export type WorkspaceState = {
  readonly currentUser: CurrentUser | null;
  readonly currentWorkspace: CurrentWorkspace | null;
  readonly connectionState: ConnectionState;
  enterWorkspace(input: EnterWorkspaceInput): Promise<void>;
  /** 个人中心保存 display_name 后回写，让侧栏等消费方同步刷新；未签入时 no-op。 */
  setCurrentUserDisplayName(displayName: string | null): void;
};

export function createWorkspaceState(options: WorkspaceStateOptions): WorkspaceState {
  let currentUser: CurrentUser | null = null;
  let currentWorkspace: CurrentWorkspace | null = null;
  let connectionState: ConnectionState = "closed";
  let unsubscribe: Array<() => void> = [];

  function emitChange(): void {
    options.onChange?.({ currentUser, currentWorkspace, connectionState });
  }

  function setConnectionState(next: ConnectionState): void {
    connectionState = next;
    emitChange();
  }

  function trackConnection(conn: SurrealConn): void {
    for (const off of unsubscribe) off();
    unsubscribe = [
      conn.subscribe("connected", () => setConnectionState("open")),
      conn.subscribe("reconnecting", () => setConnectionState("closing")),
      conn.subscribe("disconnected", () => setConnectionState("closed")),
    ];
  }

  return {
    get currentUser() {
      return currentUser;
    },
    get currentWorkspace() {
      return currentWorkspace;
    },
    get connectionState() {
      return connectionState;
    },
    async enterWorkspace(input) {
      const workspace: CurrentWorkspace = {
        dbName: input.dbName,
        ...(input.role === undefined ? {} : { role: input.role }),
        ...(input.slug === undefined ? {} : { slug: input.slug }),
        ...(input.name === undefined ? {} : { name: input.name }),
      };
      const conn = await options.connect({
        url: options.surrealUrl,
        rawToken: input.rawToken,
        namespace: options.namespace,
        dbName: workspace.dbName,
      });
      trackConnection(conn);

      currentUser = input.user ?? null;
      currentWorkspace = workspace;
      setConnectionState("open");
    },
    setCurrentUserDisplayName(displayName) {
      // 即使 currentUser 尚未从 token 初始化（解析失败的兜底），保存后也要让消费方
      // 拿到新昵称，因此 null 时新建一个仅含 displayName 的最小用户对象。
      currentUser = { ...(currentUser ?? {}), displayName };
      emitChange();
    },
  };
}
