import { createHash, createHmac } from "node:crypto";
import { RecordId, Surreal, type SurrealSession } from "surrealdb";
import { retryAtomicConflict } from "../db/atomic-conflict-retry";
import { SurrealNativeQuotaClient } from "../db/native-quota/client";
import { getRootDatabaseSession } from "../db/root-connection";
import { env } from "../env";
import { HttpError } from "../http-error";

export type RosterQuery = { query(sql: string, vars?: Record<string, unknown>): Promise<unknown> };
const rosterGatewayPrefix = "/internal/roster-meeting";
export const rosterRowsApi = `${rosterGatewayPrefix}/rows`;
export const rosterArchiveApi = `${rosterGatewayPrefix}/archive`;

export async function callRosterGateway<T>(db: RosterQuery, operation: "rows" | "sheets" | "archive", body: Record<string, unknown>) {
  const [response] = await db.query("RETURN api::invoke($path, { method: 'post', body: $body });", {
    path: `${rosterGatewayPrefix}/${operation}`, body,
  }) as [{ status: number; body: T }];
  return response;
}
type Config = {
  url: string;
  namespace: string;
  credentialSession: (database: string, namespace: string) => Promise<Pick<SurrealSession, "update">>;
};
type Connection = { db: Promise<Surreal>; expires: number; inUse: number };

const access = "roster_meeting_gateway";
const credential = new RecordId(access, "origin");
const unavailable = () => new HttpError(503, "meeting-roster-gateway-unavailable", "会议数据库会话暂不可用");

export class RosterMeetingGateway {
  private readonly connections = new Map<string, Connection>();

  constructor(private readonly key: () => string | undefined, private readonly config: Config) {}

  private async connect(database: string): Promise<Surreal> {
    const key = this.key();
    if (!key || !/^ws_[a-z0-9_]+$/u.test(database)) throw unavailable();
    const { url, namespace, credentialSession } = this.config;
    const proof = createHmac("sha256", key).update(JSON.stringify([access, namespace, database])).digest("hex");
    const db = new Surreal();
    const signin = () => db.signin({ namespace, database, access, variables: { proof } });
    try {
      await db.connect(url, { reconnect: false });
      try {
        await signin();
      } catch {
        const root = await credentialSession(database, namespace);
        const verifier = createHash("sha256").update(proof).digest("hex");
        // 只更新迁移创建的固定凭证槽。库未迁移时，UPDATE 不会创建记录。
        if (!await retryAtomicConflict(() => root.update(credential).merge({ verifier }))) throw unavailable();
        await signin();
      }
      return db;
    } catch {
      await db.close().catch(() => undefined);
      throw unavailable();
    }
  }

  private retire(database: string, current: Connection) {
    if (this.connections.get(database) === current) this.connections.delete(database);
    if (current.inUse === 0) void current.db.then((db) => db.close()).catch(() => undefined);
  }

  async session(database: string): Promise<RosterQuery> {
    return { query: async (sql, vars) => {
      const now = Date.now();
      for (const [name, value] of this.connections) {
        if (value.expires <= now || (this.connections.size >= 64 && name !== database && value.inUse === 0)) {
          this.retire(name, value);
        }
      }
      let current = this.connections.get(database);
      if (!current) {
        current = { db: this.connect(database), expires: now + 50 * 60_000, inUse: 0 };
        this.connections.set(database, current);
      }
      current.inUse++;
      let db: Surreal | undefined;
      try {
        db = await current.db;
        return await db.query(sql, vars).collect();
      } finally {
        current.inUse--;
        if (!db?.isConnected || this.connections.get(database) !== current) this.retire(database, current);
      }
    } };
  }

  close() {
    for (const [database, current] of this.connections) this.retire(database, current);
  }
}

const gateway = new RosterMeetingGateway(() => env.MEETING_ROSTER_PEPPER ?? env.MEETING_EVIDENCE_MASTER_KEY, {
  url: env.SURREAL_URL,
  namespace: env.SURREAL_NS,
  credentialSession: getRootDatabaseSession,
});

export const getRosterMeetingSession = (database: string) => gateway.session(database);

// INFO FOR QUOTA 属于配额控制面，RECORD 会话只接受引擎对 DML 的配额裁决。
export async function readRosterMeetingQuota(database: string) {
  return new SurrealNativeQuotaClient(await getRootDatabaseSession(database)).info(database);
}
