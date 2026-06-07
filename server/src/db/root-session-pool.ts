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

function sessionKey(namespace: string, database: string): string {
  return `${namespace}/${database}`;
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
      try {
        const session = await sessionPromise;
        await session.closeSession();
      } catch {
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
        return existing;
      }

      const creating = (async () => {
        const session = await source.newSession();
        await session.use({ namespace, database });
        return session;
      })();

      sessions.set(key, creating);
      try {
        const session = await creating;
        await evictIfNeeded();
        return session;
      } catch (error) {
        if (sessions.get(key) === creating) {
          sessions.delete(key);
        }
        throw error;
      }
    },

    async closeAll() {
      const pending = [...sessions.values()];
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
    },

    size() {
      return sessions.size;
    },
  };
}
