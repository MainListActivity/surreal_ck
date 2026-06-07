import { Surreal } from "surrealdb";
import { env } from "../env";
import { instrumentSurrealQuery } from "./query-logging";
import { createRootSessionPool } from "./root-session-pool";

let rootConnection: Surreal | null = null;
let connected = false;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let closing = false;
let rootConnectionGeneration = 0;
let rootSessionCreateSeq = 0;

const BACKOFF_MS = [1000, 2000, 5000, 10000] as const;
const CONNECT_TIMEOUT_MS = 3000;
const ROOT_DEBUG_PREFIX = "[DEBUG-surreal-root]";

function debugRoot(event: string, payload: Record<string, unknown>): void {
  console.info(ROOT_DEBUG_PREFIX, event, payload);
}

function warnRoot(event: string, payload: Record<string, unknown>): void {
  console.warn(ROOT_DEBUG_PREFIX, event, payload);
}

function errorForLog(error: unknown): Record<string, unknown> {
  return {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}

const rootSessionPool = createRootSessionPool({
  async newSession() {
    const sessionSeq = ++rootSessionCreateSeq;
    debugRoot("session:new:start", {
      sessionSeq,
      connected,
      rootIsConnected: rootConnection?.isConnected ?? null,
      generation: rootConnectionGeneration,
    });
    try {
      const session = await getRootConnection().newSession();
      debugRoot("session:new:transport-ready", {
        sessionSeq,
        connected,
        rootIsConnected: rootConnection?.isConnected ?? null,
        generation: rootConnectionGeneration,
      });
      const loggedSession = instrumentSurrealQuery(session, { source: "server:root-session" });
      await loggedSession.signin({
        username: env.SURREAL_ROOT_USER,
        password: env.SURREAL_ROOT_PASS,
      });
      debugRoot("session:new:signed-in", {
        sessionSeq,
        connected,
        rootIsConnected: rootConnection?.isConnected ?? null,
        generation: rootConnectionGeneration,
      });
      return loggedSession;
    } catch (error) {
      warnRoot("session:new:failed", {
        sessionSeq,
        connected,
        rootIsConnected: rootConnection?.isConnected ?? null,
        generation: rootConnectionGeneration,
        ...errorForLog(error),
      });
      throw error;
    }
  },
});

function nextDelayMs(): number {
  return BACKOFF_MS[Math.min(reconnectAttempts, BACKOFF_MS.length - 1)];
}

function scheduleReconnect(): void {
  if (closing || reconnectTimer) {
    debugRoot("reconnect:skip-schedule", {
      closing,
      hasTimer: Boolean(reconnectTimer),
      connected,
      rootIsConnected: rootConnection?.isConnected ?? null,
      generation: rootConnectionGeneration,
    });
    return;
  }

  const delayMs = nextDelayMs();
  reconnectAttempts += 1;
  console.warn("[surrealdb] root reconnect scheduled", { delayMs, attempt: reconnectAttempts });

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectRootOnce();
  }, delayMs);
}

async function connectRootOnce(): Promise<void> {
  if (closing) {
    debugRoot("connect:skip-closing", {
      connected,
      rootIsConnected: rootConnection?.isConnected ?? null,
      generation: rootConnectionGeneration,
    });
    return;
  }

  const db = new Surreal();
  const nextGeneration = rootConnectionGeneration + 1;
  debugRoot("connect:start", {
    nextGeneration,
    url: env.SURREAL_URL,
    namespace: env.SURREAL_NS,
    connected,
    rootIsConnected: rootConnection?.isConnected ?? null,
    reconnectAttempts,
  });

  db.subscribe("disconnected", () => {
    if (closing) return;
    connected = false;
    console.warn("[surrealdb] root connection disconnected");
    warnRoot("event:disconnected", {
      generation: rootConnectionGeneration,
      connected,
      rootIsConnected: rootConnection?.isConnected ?? null,
    });
    scheduleReconnect();
  });

  db.subscribe("error", (error) => {
    connected = false;
    console.warn("[surrealdb] root connection error", { message: error.message });
    warnRoot("event:error", {
      generation: rootConnectionGeneration,
      connected,
      rootIsConnected: rootConnection?.isConnected ?? null,
      message: error.message,
    });
    scheduleReconnect();
  });

  try {
    await Promise.race([
      (async () => {
        await db.connect(env.SURREAL_URL, { reconnect: false });
        debugRoot("connect:transport-ready", { nextGeneration, namespace: env.SURREAL_NS });
        await db.signin({
          username: env.SURREAL_ROOT_USER,
          password: env.SURREAL_ROOT_PASS,
        });
        debugRoot("connect:signed-in", { nextGeneration, namespace: env.SURREAL_NS });
        await db.use({ namespace: env.SURREAL_NS, database: "_system" });
        debugRoot("connect:use-system-ready", { nextGeneration, namespace: env.SURREAL_NS, database: "_system" });
      })(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("SurrealDB root connection timeout")), CONNECT_TIMEOUT_MS)
      ),
    ]);

    const previousConnection = rootConnection;
    await rootSessionPool.closeAll();
    if (previousConnection && previousConnection !== db) {
      try {
        await previousConnection.close();
      } catch {
        // Ignore cleanup errors for a stale connection after reconnect.
      }
    }

    rootConnection = instrumentSurrealQuery(db, {
      source: "server:root",
      initialScope: { namespace: env.SURREAL_NS, database: "_system" },
    });
    connected = true;
    reconnectAttempts = 0;
    rootConnectionGeneration = nextGeneration;
    console.info("[surrealdb] root connected", { url: env.SURREAL_URL, namespace: env.SURREAL_NS });
    debugRoot("connect:ready", {
      generation: rootConnectionGeneration,
      connected,
      rootIsConnected: rootConnection.isConnected,
      poolSize: rootSessionPool.size(),
    });
  } catch (error) {
    connected = false;
    try {
      await db.close();
    } catch {
      // Ignore close errors while handling a failed connection attempt.
    }

    console.warn("[surrealdb] root connection failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    warnRoot("connect:failed", {
      nextGeneration,
      connected,
      rootIsConnected: rootConnection?.isConnected ?? null,
      reconnectAttempts,
      ...errorForLog(error),
    });
    scheduleReconnect();
  }
}

export async function initRootConnection(): Promise<void> {
  closing = false;
  debugRoot("init:start", {
    connected,
    rootIsConnected: rootConnection?.isConnected ?? null,
    generation: rootConnectionGeneration,
  });
  await connectRootOnce();
}

export function getRootConnection(): Surreal {
  if (!rootConnection) {
    throw new Error("SurrealDB root connection is not initialized");
  }
  return rootConnection;
}

export async function getRootDatabaseSession(database: string, namespace = env.SURREAL_NS) {
  debugRoot("database-session:get", {
    namespace,
    database,
    connected,
    rootIsConnected: rootConnection?.isConnected ?? null,
    generation: rootConnectionGeneration,
    poolSize: rootSessionPool.size(),
  });
  return rootSessionPool.get(database, namespace);
}

export function isRootConnected(): boolean {
  return connected && rootConnection?.isConnected === true;
}

export async function checkRootConnection(timeoutMs = 5000): Promise<boolean> {
  debugRoot("health:start", {
    timeoutMs,
    connected,
    rootIsConnected: rootConnection?.isConnected ?? null,
    generation: rootConnectionGeneration,
  });
  if (!isRootConnected()) {
    debugRoot("health:down-before-query", {
      timeoutMs,
      connected,
      rootIsConnected: rootConnection?.isConnected ?? null,
      generation: rootConnectionGeneration,
    });
    return false;
  }

  try {
    await Promise.race([
      getRootConnection().query("RETURN 1"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("SurrealDB health timeout")), timeoutMs)),
    ]);
    debugRoot("health:ok", {
      timeoutMs,
      connected,
      rootIsConnected: rootConnection?.isConnected ?? null,
      generation: rootConnectionGeneration,
    });
    return true;
  } catch (error) {
    connected = false;
    console.warn("[surrealdb] root health probe failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    warnRoot("health:failed", {
      timeoutMs,
      connected,
      rootIsConnected: rootConnection?.isConnected ?? null,
      generation: rootConnectionGeneration,
      ...errorForLog(error),
    });
    scheduleReconnect();
    return false;
  }
}

export async function closeRootConnection(): Promise<void> {
  closing = true;
  debugRoot("close:start", {
    connected,
    rootIsConnected: rootConnection?.isConnected ?? null,
    generation: rootConnectionGeneration,
    poolSize: rootSessionPool.size(),
  });

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const db = rootConnection;
  rootConnection = null;
  connected = false;

  await rootSessionPool.closeAll();

  if (db) {
    await db.close();
  }
  debugRoot("close:done", {
    connected,
    rootIsConnected: rootConnection?.isConnected ?? null,
    generation: rootConnectionGeneration,
    poolSize: rootSessionPool.size(),
  });
}
