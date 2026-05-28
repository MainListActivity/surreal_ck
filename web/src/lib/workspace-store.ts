import type { AuthClaims } from "./auth";
import type { SurrealAccess, SurrealConn, SurrealConnectInput } from "./surreal";

export type ConnectionState = "open" | "closing" | "closed";

export type CurrentUser = {
  subject: string;
  email: string;
  name?: string;
};

export type CurrentWorkspace = {
  /** Filled by the Workspace Scope Module (issue 05); token only carries the db. */
  slug?: string;
  name?: string;
  dbName: string;
  role: SurrealAccess;
};

export type EnterWorkspaceInput = {
  rawToken: string;
  claims: AuthClaims;
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
};

function userFromClaims(claims: AuthClaims): CurrentUser {
  return {
    subject: claims.sub,
    email: claims.email,
    ...(claims.name === undefined ? {} : { name: claims.name }),
  };
}

function workspaceFromClaims(claims: AuthClaims): CurrentWorkspace {
  return {
    dbName: claims["https://surrealdb.com/db"],
    role: claims["https://surrealdb.com/ac"],
  };
}

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
    async enterWorkspace({ rawToken, claims }) {
      const workspace = workspaceFromClaims(claims);
      const conn = await options.connect({
        url: options.surrealUrl,
        rawToken,
        namespace: options.namespace,
        dbName: workspace.dbName,
        access: workspace.role,
      });
      trackConnection(conn);

      currentUser = userFromClaims(claims);
      currentWorkspace = workspace;
      setConnectionState("open");
    },
  };
}
