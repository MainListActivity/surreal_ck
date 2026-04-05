/// <reference lib="webworker" />
/// <reference types="vite/client" />

import { Surreal, type Tokens } from 'surrealdb';

import { readOfflineValue, removeOfflineValue, writeOfflineValue } from './offline-store';
import type { WorkerEvent, WorkerRequest, WorkerRequestType, WorkerResponse } from './protocol';
import type { ConnectionSnapshot, ConnectionState, EnvironmentConfig } from './types';

const DEFAULT_AUTH_ACCESS = 'lawyer_access';
const TOKENS_KEY = 'auth.tokens';
const SNAPSHOT_KEY = 'connection.snapshot';

const db = new Surreal();
const workerScope = self as DedicatedWorkerGlobalScope;

let listenersAttached = false;
let snapshot: ConnectionSnapshot = {
  state: 'idle',
  updatedAt: Date.now(),
};

const getEnvironmentConfig = (
  env: ImportMetaEnv | Record<string, string | undefined> = import.meta.env,
): EnvironmentConfig => ({
  surrealUrl: env.VITE_SURREAL_URL ?? 'ws://localhost:8000/rpc',
  namespace: env.VITE_SURREAL_NS ?? 'surreal_ck',
  database: env.VITE_SURREAL_DB ?? 'app',
  authAccess: env.VITE_SURREAL_ACCESS ?? DEFAULT_AUTH_ACCESS,
});

function postEvent(event: WorkerEvent): void {
  workerScope.postMessage(event);
}

async function updateSnapshot(state: ConnectionState, detail?: string): Promise<void> {
  snapshot = {
    state,
    detail,
    updatedAt: Date.now(),
  };

  await writeOfflineValue(SNAPSHOT_KEY, snapshot);
  postEvent({
    kind: 'connection-state',
    snapshot,
  });
}

function attachConnectionListeners(): void {
  if (listenersAttached) {
    return;
  }

  db.subscribe('connecting', () => {
    void updateSnapshot('connecting');
  });

  db.subscribe('connected', (url) => {
    void updateSnapshot('connected', url);
  });

  db.subscribe('reconnecting', () => {
    void updateSnapshot('reconnecting');
  });

  db.subscribe('disconnected', () => {
    void updateSnapshot('disconnected');
  });

  db.subscribe('error', (error) => {
    void updateSnapshot('error', error.message);
  });

  db.subscribe('auth', (tokens) => {
    const nextState = tokens ? 'connected' : 'disconnected';
    void updateSnapshot(nextState);
  });

  listenersAttached = true;
}

async function connect(): Promise<boolean> {
  const config = getEnvironmentConfig();

  attachConnectionListeners();
  await updateSnapshot('connecting');

  try {
    await db.connect(config.surrealUrl, {
      namespace: config.namespace,
      database: config.database,
      reconnect: {
        enabled: true,
        attempts: -1,
        retryDelay: 1_000,
        retryDelayMax: 30_000,
      },
    });

    return true;
  } catch (error) {
    await updateSnapshot(
      'disconnected',
      error instanceof Error ? error.message : 'Offline bootstrap failed',
    );
    return false;
  }
}

async function readTokens(): Promise<Tokens | null> {
  return readOfflineValue<Tokens>(TOKENS_KEY);
}

async function writeTokens(tokens: Tokens): Promise<void> {
  await writeOfflineValue(TOKENS_KEY, tokens);
}

async function clearTokens(): Promise<void> {
  await removeOfflineValue(TOKENS_KEY);
}

async function signIn(payload: { email: string; password: string }): Promise<Tokens> {
  const config = getEnvironmentConfig();

  await updateSnapshot('connecting');

  const tokens = await db.signin({
    namespace: config.namespace,
    database: config.database,
    access: config.authAccess,
    variables: {
      email: payload.email,
      password: payload.password,
    },
  });

  await writeTokens(tokens);
  await updateSnapshot('connected');

  return tokens;
}

async function restoreSession(): Promise<Tokens | null> {
  const tokens = await readTokens();

  if (!tokens) {
    const cachedSnapshot = await readOfflineValue<ConnectionSnapshot>(SNAPSHOT_KEY);

    if (cachedSnapshot) {
      snapshot = cachedSnapshot;
      postEvent({
        kind: 'connection-state',
        snapshot,
      });
    }

    return null;
  }

  try {
    await updateSnapshot('connecting');
    const refreshed = await db.authenticate(tokens);
    await writeTokens(refreshed);
    await updateSnapshot('connected');
    return refreshed;
  } catch (error) {
    await clearTokens();
    await updateSnapshot(
      'disconnected',
      error instanceof Error ? error.message : 'Session invalid',
    );
    return null;
  }
}

async function signOut(): Promise<true> {
  try {
    await db.invalidate();
  } finally {
    await clearTokens();
    await updateSnapshot('disconnected');
  }

  return true;
}

async function close(): Promise<true> {
  await db.close();
  await updateSnapshot('disconnected');
  return true;
}

async function execute(request: WorkerRequest): Promise<boolean | true | Tokens | Tokens | null | ConnectionSnapshot> {
  switch (request.type) {
    case 'connect':
      return connect();
    case 'close':
      return close();
    case 'signIn':
      return signIn(request.payload as { email: string; password: string });
    case 'restoreSession':
      return restoreSession();
    case 'signOut':
      return signOut();
    case 'getConnectionSnapshot':
      return snapshot;
    default:
      throw new Error(`Unsupported worker request: ${String(request.type)}`);
  }
}

workerScope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    const result = await execute(request);
    const response: WorkerResponse = {
      id: request.id,
      ok: true,
      result: result as never,
    };

    workerScope.postMessage(response);
  } catch (error) {
    const response: WorkerResponse = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown worker error',
    };

    workerScope.postMessage(response);
  }
};
