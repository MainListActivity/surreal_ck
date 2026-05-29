import { Surreal } from "surrealdb";

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "reconnecting"
  | "connected";

export type SurrealConnectInput = {
  url: string;
  rawToken: string;
  namespace: string;
  dbName: string;
};

/**
 * The slice of the official `surrealdb` driver this module depends on.
 * Kept narrow so the connection lifecycle can be unit-tested with a fake.
 */
export type SurrealConn = {
  readonly status: ConnectionStatus;
  connect(url: string, opts?: unknown): Promise<true>;
  use(what?: { namespace?: string; database?: string }): Promise<unknown>;
  close(): Promise<true>;
  subscribe(event: string, listener: (...payload: unknown[]) => void): () => void;
};

export type SurrealClientOptions = {
  factory?: () => SurrealConn;
};

export type SurrealClient = {
  connectSurreal(input: SurrealConnectInput): Promise<SurrealConn>;
  getSurreal(): SurrealConn;
  closeSurreal(): Promise<void>;
};

function browserFactory(): SurrealConn {
  return new Surreal() as unknown as SurrealConn;
}

export function createSurrealClient(options: SurrealClientOptions = {}): SurrealClient {
  const factory = options.factory ?? browserFactory;
  let db: SurrealConn | null = null;

  return {
    async connectSurreal(input) {
      // Close the previous connection first so two connections never hold
      // overlapping LIVE subscriptions during a workspace switch.
      if (db) await db.close();
      db = null;

      const next = factory();
      await next.connect(input.url, {
        namespace: input.namespace,
        database: input.dbName,
        authentication: input.rawToken,
      });
      db = next;
      return next;
    },
    getSurreal() {
      if (!db) throw new Error("Surreal not connected");
      return db;
    },
    async closeSurreal() {
      await db?.close();
      db = null;
    },
  };
}

const defaultClient = createSurrealClient();

export function connectSurreal(input: SurrealConnectInput): Promise<SurrealConn> {
  return defaultClient.connectSurreal(input);
}

export function getSurreal(): SurrealConn {
  return defaultClient.getSurreal();
}

export function closeSurreal(): Promise<void> {
  return defaultClient.closeSurreal();
}
