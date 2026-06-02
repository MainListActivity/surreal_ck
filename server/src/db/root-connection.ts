import { Surreal } from "surrealdb";
import { env } from "../env";
import { createRootSessionPool } from "./root-session-pool";

let rootConnection: Surreal | null = null;
let connected = false;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let closing = false;

const BACKOFF_MS = [1000, 2000, 5000, 10000] as const;
const CONNECT_TIMEOUT_MS = 3000;
const rootSessionPool = createRootSessionPool({
  async newSession() {
    const session = await getRootConnection().newSession();
    await session.signin({
      username: env.SURREAL_ROOT_USER,
      password: env.SURREAL_ROOT_PASS,
    });
    return session;
  },
});

function nextDelayMs(): number {
  return BACKOFF_MS[Math.min(reconnectAttempts, BACKOFF_MS.length - 1)];
}

function scheduleReconnect(): void {
  if (closing || reconnectTimer) return;

  const delayMs = nextDelayMs();
  reconnectAttempts += 1;
  console.warn("[surrealdb] root reconnect scheduled", { delayMs, attempt: reconnectAttempts });

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectRootOnce();
  }, delayMs);
}

async function connectRootOnce(): Promise<void> {
  if (closing) return;

  const db = new Surreal();

  db.subscribe("disconnected", () => {
    if (closing) return;
    connected = false;
    console.warn("[surrealdb] root connection disconnected");
    scheduleReconnect();
  });

  db.subscribe("error", (error) => {
    connected = false;
    console.warn("[surrealdb] root connection error", { message: error.message });
    scheduleReconnect();
  });

  try {
    await Promise.race([
      (async () => {
        await db.connect(env.SURREAL_URL, { reconnect: false });
        await db.signin({
          username: env.SURREAL_ROOT_USER,
          password: env.SURREAL_ROOT_PASS,
        });
        await db.use({ namespace: env.SURREAL_NS, database: "_system" });
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

    rootConnection = db;
    connected = true;
    reconnectAttempts = 0;
    console.info("[surrealdb] root connected", { url: env.SURREAL_URL, namespace: env.SURREAL_NS });
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
    scheduleReconnect();
  }
}

export async function initRootConnection(): Promise<void> {
  closing = false;
  await connectRootOnce();
}

export function getRootConnection(): Surreal {
  if (!rootConnection) {
    throw new Error("SurrealDB root connection is not initialized");
  }
  return rootConnection;
}

export async function getRootDatabaseSession(database: string, namespace = env.SURREAL_NS) {
  return rootSessionPool.get(database, namespace);
}

export function isRootConnected(): boolean {
  return connected && rootConnection?.isConnected === true;
}

export async function checkRootConnection(timeoutMs = 5000): Promise<boolean> {
  if (!isRootConnected()) return false;

  try {
    await Promise.race([
      getRootConnection().query("RETURN 1"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("SurrealDB health timeout")), timeoutMs)),
    ]);
    return true;
  } catch (error) {
    connected = false;
    console.warn("[surrealdb] root health probe failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    scheduleReconnect();
    return false;
  }
}

export async function closeRootConnection(): Promise<void> {
  closing = true;

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
}
