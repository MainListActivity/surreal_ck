import { StringRecordId, Surreal, Table } from "surrealdb";

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

/** LIVE SELECT 推送给订阅者的单条变更。`action` 决定如何处理 `value`。 */
export type LiveAction = "CREATE" | "UPDATE" | "DELETE" | "KILLED";

export type LiveMessage = {
  action: LiveAction;
  value: Record<string, unknown>;
};

export type SurrealWriter = {
  /** MERGE 更新单条记录；`id` 是 RecordId 字符串，内部包成 StringRecordId。 */
  updateRecord<T = Record<string, unknown>>(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<T>;
  /** 在指定表 content 一条新记录。 */
  createRecord<T = Record<string, unknown>>(
    table: string,
    data: Record<string, unknown>,
  ): Promise<T>;
  /** 删除单条记录；`id` 是 RecordId 字符串，内部包成 StringRecordId。 */
  deleteRecord(id: string): Promise<unknown>;
};

/**
 * The slice of the official `surrealdb` driver this module depends on.
 * Kept narrow so the connection lifecycle and data layer can be unit-tested
 * with a fake. `query` / `liveTable` 把 driver 的链式/Promise API
 *（`query().collect()`、`await live()` 后 `subscribe()`）收敛成一次性原语。
 */
export type SurrealConn = SurrealWriter & {
  readonly status: ConnectionStatus;
  connect(url: string, opts?: unknown): Promise<true>;
  use(what?: { namespace?: string; database?: string }): Promise<unknown>;
  close(): Promise<true>;
  subscribe(event: string, listener: (...payload: unknown[]) => void): () => void;
  /** 执行 SurrealQL，返回**首个**语句的结果集。参数化绑定防注入。 */
  query<T = unknown>(sql: string, bindings?: Record<string, unknown>): Promise<T[]>;
  /** 订阅整张表的 LIVE 变更；返回取消订阅函数。 */
  liveTable<T extends Record<string, unknown> = Record<string, unknown>>(
    table: string,
    onMessage: (message: LiveMessage & { value: T }) => void,
  ): Promise<() => void>;
  /** 在 SurrealDB 事务内执行一批写入；失败时 cancel，成功时 commit。 */
  transaction<T>(run: (tx: SurrealWriter) => Promise<T>): Promise<T>;
};

/** driver 上 query / live / update / create 的最小形状，仅用于浏览器 adapter 内部桥接。 */
type RawWriter = {
  update(id: unknown): { merge(patch: Record<string, unknown>): Promise<unknown> };
  create(what: unknown): { content(data: Record<string, unknown>): Promise<unknown> };
  delete(id: unknown): Promise<unknown>;
};

type RawTransaction = RawWriter & {
  commit(): Promise<void>;
  cancel(): Promise<void>;
};

type RawDriver = {
  query(sql: string, bindings?: Record<string, unknown>): { collect(): Promise<unknown[]> };
  live(what: Table): PromiseLike<{ subscribe(handler: (message: LiveMessage) => void): () => void }>;
  beginTransaction(): Promise<RawTransaction>;
} & RawWriter;

function createWriter(raw: RawWriter): SurrealWriter {
  const rawUpdate = raw.update;
  const rawCreate = raw.create;
  const rawDelete = raw.delete;
  return {
    async updateRecord<T = Record<string, unknown>>(
      id: string,
      patch: Record<string, unknown>,
    ): Promise<T> {
      return (await rawUpdate.call(raw, new StringRecordId(id)).merge(patch)) as T;
    },
    async createRecord<T = Record<string, unknown>>(
      table: string,
      data: Record<string, unknown>,
    ): Promise<T> {
      return (await rawCreate.call(raw, new Table(table)).content(data)) as T;
    },
    async deleteRecord(id: string): Promise<unknown> {
      return await rawDelete.call(raw, new StringRecordId(id));
    },
  };
}

/**
 * 把官方 `Surreal` 实例适配成本模块的窄 {@link SurrealConn}：
 * `query().collect()` 取首个结果集；`live()` 返回订阅对象后再转交回调。
 */
export function createBrowserConn(raw: RawDriver): SurrealConn {
  // 捕获原始链式方法后再扩展：conn 与 raw 是同一对象，若覆盖后再调用
  // raw.query 会命中新 query（自指），故先取出原实现引用。
  const rawQuery = raw.query;
  const rawLive = raw.live;
  const rawBeginTransaction = raw.beginTransaction;
  const conn = raw as unknown as SurrealConn;
  const writer = createWriter(raw);
  return Object.assign(conn, {
    async query<T = unknown>(sql: string, bindings?: Record<string, unknown>): Promise<T[]> {
      const collected = await rawQuery.call(raw, sql, bindings).collect();
      return (collected[0] ?? []) as T[];
    },
    async liveTable<T extends Record<string, unknown> = Record<string, unknown>>(
      table: string,
      onMessage: (message: LiveMessage & { value: T }) => void,
    ): Promise<() => void> {
      const subscription = await rawLive.call(raw, new Table(table));
      return subscription.subscribe(onMessage as (message: LiveMessage) => void);
    },
    updateRecord: writer.updateRecord,
    createRecord: writer.createRecord,
    deleteRecord: writer.deleteRecord,
    async transaction<T>(run: (tx: SurrealWriter) => Promise<T>): Promise<T> {
      const tx = await rawBeginTransaction.call(raw);
      try {
        const result = await run(createWriter(tx));
        await tx.commit();
        return result;
      } catch (err) {
        try {
          await tx.cancel();
        } catch {
          // The original write error is more useful to callers than a rollback error.
        }
        throw err;
      }
    },
  });
}

export type SurrealClientOptions = {
  factory?: () => SurrealConn;
};

export type SurrealClient = {
  connectSurreal(input: SurrealConnectInput): Promise<SurrealConn>;
  getSurreal(): SurrealConn;
  closeSurreal(): Promise<void>;
};

function browserFactory(): SurrealConn {
  return createBrowserConn(new Surreal() as unknown as RawDriver);
}

export function createSurrealClient(options: SurrealClientOptions = {}): SurrealClient {
  const factory = options.factory ?? browserFactory;
  let db: SurrealConn | null = null;

  return {
    async connectSurreal(input) {
      // Fail fast with an actionable message: when VITE_SURREAL_URL is missing,
      // input.url is undefined/"" and surrealdb's parseEndpoint throws an opaque
      // "Cannot read properties of undefined (reading 'href')" deep in its driver.
      if (!input.url) {
        throw new Error(
          "SurrealDB 连接地址为空：请配置 VITE_SURREAL_URL（仓库根 .env，见 .env.example）。",
        );
      }

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
