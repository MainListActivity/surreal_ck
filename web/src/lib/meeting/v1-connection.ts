import { createApiClient } from "../api";
import { getToken, isAuthenticated, parseUserFromToken } from "../auth";
import { createSurrealClient, type SurrealConn } from "../surreal";
import { tokenMatchesWorkspaceScope } from "../switch-workspace";
import { MeetingRpcError } from "./rpc";

type QueryConn = Pick<SurrealConn, "query">;
type MemberConn = Pick<SurrealConn, "query" | "close">;

type SessionDeps = {
  currentToken(): string | null;
  exchange(dbName: string, sourceToken: string): Promise<{ accessToken: string; expiresIn: number | null }>;
  connect(dbName: string, token: string): Promise<MemberConn>;
};

type PendingConnection = { source: string; expiresAt: number; conn: Promise<MemberConn> };

const defaults: SessionDeps = {
  currentToken: () => isAuthenticated() ? getToken() : null,
  async exchange(dbName, sourceToken) {
    const { api } = createApiClient({ getToken: () => sourceToken });
    const response = await api.api.session["collaboration-scope"].$post(
      { json: { dbName } },
      { init: { cache: "no-store", signal: AbortSignal.timeout(10_000) } },
    );
    if (response.status === 403 || response.status === 409) throw new MeetingRpcError("denied");
    if (!response.ok) throw new MeetingRpcError("unavailable");
    return response.json();
  },
  connect: (dbName, rawToken) => createSurrealClient().connectSurreal({
    url: import.meta.env.VITE_SURREAL_URL,
    namespace: "main",
    dbName,
    rawToken,
  }),
};

/** V1 必须以本人 user: RECORD 身份操作；管理员业务连接不参与会议 RPC。 */
export function createMeetingV1Connection(dbName: string, workspaceConn: QueryConn, deps = defaults) {
  const subject = parseUserFromToken(deps.currentToken())?.subject;
  let closed = false;
  let pending: PendingConnection | undefined;

  async function release(): Promise<void> {
    const previous = pending;
    pending = undefined;
    if (previous) await previous.conn.then((conn) => conn.close()).catch(() => undefined);
  }

  function isCurrent(token: string): boolean {
    return !closed && deps.currentToken() === token;
  }

  return {
    async query<T>(sql: string, bindings?: Record<string, unknown>): Promise<T[]> {
      const source = deps.currentToken();
      if (closed || !subject || !source || parseUserFromToken(source)?.subject !== subject) {
        void release();
        throw new MeetingRpcError("denied");
      }
      if (tokenMatchesWorkspaceScope(source, { dbName, role: "participant" })) {
        void release();
        return workspaceConn.query<T>(sql, bindings);
      }
      if (!tokenMatchesWorkspaceScope(source, { dbName, role: "admin" })) {
        void release();
        throw new MeetingRpcError("denied");
      }
      if (!pending || pending.source !== source || pending.expiresAt <= Date.now()) {
        void release();
        const entry: PendingConnection = {
          source,
          expiresAt: Number.POSITIVE_INFINITY,
          conn: deps.exchange(dbName, source).then(({ accessToken, expiresIn }) => {
            if (!isCurrent(source) || pending !== entry
              || !tokenMatchesWorkspaceScope(accessToken, { dbName, role: "participant" })
              || parseUserFromToken(accessToken)?.subject !== subject
              || (expiresIn !== null && expiresIn <= 0)) {
              throw new MeetingRpcError("denied");
            }
            if (expiresIn !== null) entry.expiresAt = Date.now() + expiresIn * 1000;
            return deps.connect(dbName, accessToken);
          }),
        };
        pending = entry;
        void entry.conn.catch(() => {
          if (pending === entry) pending = undefined;
        });
      }
      const entry = pending;
      const conn = await entry.conn;
      if (!isCurrent(source) || pending !== entry) throw new MeetingRpcError("denied");
      return conn.query<T>(sql, bindings);
    },
    async close(): Promise<void> {
      closed = true;
      await release();
    },
  };
}
