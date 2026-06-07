export type RootDatabaseSession = {
  use(scope: { namespace: string; database: string }): Promise<unknown>;
  closeSession(): Promise<unknown>;
};

export type RootSessionSource<TSession extends RootDatabaseSession = RootDatabaseSession> = {
  newSession(): Promise<TSession>;
};

export type RootSessionPool<TSession extends RootDatabaseSession = RootDatabaseSession> = {
  get(database: string, namespace: string): Promise<TSession>;
  closeAll(): Promise<void>;
  size(): number;
};

export type RootSessionPoolOptions = {
  maxSessions?: number;
};

const DEFAULT_MAX_SESSIONS = 20;
const ROOT_SESSION_POOL_DEBUG_PREFIX = "[DEBUG-root-session-pool]";

function sessionKey(namespace: string, database: string): string {
  return `${namespace}/${database}`;
}

function debugRootSessionPool(event: string, payload: Record<string, unknown>): void {
  console.info(ROOT_SESSION_POOL_DEBUG_PREFIX, event, payload);
}

function warnRootSessionPool(event: string, payload: Record<string, unknown>): void {
  console.warn(ROOT_SESSION_POOL_DEBUG_PREFIX, event, payload);
}

function errorForLog(error: unknown): Record<string, unknown> {
  return {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}

export function createRootSessionPool<TSession extends RootDatabaseSession>(
  source: RootSessionSource<TSession>,
  options: RootSessionPoolOptions = {},
): RootSessionPool<TSession> {
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessions = new Map<string, Promise<TSession>>();

  async function evictIfNeeded(): Promise<void> {
    while (sessions.size > maxSessions) {
      const oldest = sessions.entries().next().value;
      if (!oldest) return;

      const [key, sessionPromise] = oldest;
      sessions.delete(key);
      debugRootSessionPool("evict:start", { key, size: sessions.size, maxSessions });
      try {
        const session = await sessionPromise;
        await session.closeSession();
        debugRootSessionPool("evict:closed", { key, size: sessions.size, maxSessions });
      } catch {
        warnRootSessionPool("evict:close-failed", { key, size: sessions.size, maxSessions });
        // Eviction must not fail the request that made room in the pool.
      }
    }
  }

  return {
    async get(database, namespace) {
      const key = sessionKey(namespace, database);
      const existing = sessions.get(key);
      if (existing) {
        sessions.delete(key);
        sessions.set(key, existing);
        debugRootSessionPool("get:hit", { key, namespace, database, size: sessions.size });
        return existing;
      }

      debugRootSessionPool("get:miss", { key, namespace, database, size: sessions.size });
      const creating = (async () => {
        debugRootSessionPool("create:start", { key, namespace, database, size: sessions.size });
        const session = await source.newSession();
        debugRootSessionPool("create:session-ready", { key, namespace, database, size: sessions.size });
        await session.use({ namespace, database });
        debugRootSessionPool("create:use-ready", { key, namespace, database, size: sessions.size });
        return session;
      })();

      sessions.set(key, creating);
      try {
        const session = await creating;
        await evictIfNeeded();
        debugRootSessionPool("get:ready", { key, namespace, database, size: sessions.size });
        return session;
      } catch (error) {
        if (sessions.get(key) === creating) {
          sessions.delete(key);
        }
        warnRootSessionPool("get:failed", {
          key,
          namespace,
          database,
          size: sessions.size,
          ...errorForLog(error),
        });
        throw error;
      }
    },

    async closeAll() {
      const pending = [...sessions.values()];
      debugRootSessionPool("close-all:start", { count: pending.length });
      sessions.clear();
      await Promise.all(
        pending.map(async (sessionPromise) => {
          try {
            const session = await sessionPromise;
            await session.closeSession();
          } catch {
            // Closing is best-effort during shutdown.
          }
        }),
      );
      debugRootSessionPool("close-all:done", { count: pending.length });
    },

    size() {
      return sessions.size;
    },
  };
}
