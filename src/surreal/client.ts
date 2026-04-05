/// <reference types="vite/client" />

import { Surreal, type Tokens } from 'surrealdb';

import type { ConnectionSnapshot, ConnectionState, EnvironmentConfig } from './types';

const DEFAULT_AUTH_ACCESS = 'lawyer_access';

type Listener = (snapshot: ConnectionSnapshot) => void;

class ConnectionStateStore {
  #snapshot: ConnectionSnapshot = {
    state: 'idle',
    updatedAt: Date.now(),
  };

  #listeners = new Set<Listener>();

  getSnapshot(): ConnectionSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    listener(this.#snapshot);

    return () => {
      this.#listeners.delete(listener);
    };
  }

  set(state: ConnectionState, detail?: string): void {
    this.#snapshot = {
      state,
      detail,
      updatedAt: Date.now(),
    };

    for (const listener of this.#listeners) {
      listener(this.#snapshot);
    }
  }
}

export const connectionState = new ConnectionStateStore();
export const getEnvironmentConfig = (
  env: ImportMetaEnv | Record<string, string | undefined> = import.meta.env,
): EnvironmentConfig => ({
  surrealUrl: env.VITE_SURREAL_URL ?? 'wss://cuckoox-06efnpc64psu927c5555v64q5g.aws-usw2.surreal.cloud/rpc',
  namespace: env.VITE_SURREAL_NS ?? 'main',
  database: env.VITE_SURREAL_DB ?? 'main',
  authAccess: env.VITE_SURREAL_ACCESS ?? DEFAULT_AUTH_ACCESS,
});

const db = new Surreal();
const attachedClients = new WeakSet<object>();

export type SurrealLike = Pick<
  Surreal,
  'connect' | 'close' | 'signin' | 'authenticate' | 'invalidate' | 'subscribe'
>;

export const surreal = db;

export function attachConnectionListeners(client: SurrealLike = db): void {
  if (attachedClients.has(client as object)) {
    return;
  }

  client.subscribe('connecting', () => {
    connectionState.set('connecting');
  });

  client.subscribe('connected', (url) => {
    connectionState.set('connected', url);
  });

  client.subscribe('reconnecting', () => {
    connectionState.set('reconnecting');
  });

  client.subscribe('disconnected', () => {
    connectionState.set('disconnected');
  });

  client.subscribe('error', (error) => {
    connectionState.set('error', error.message);
  });

  client.subscribe('auth', (tokens) => {
    const nextState = tokens ? 'connected' : 'disconnected';
    connectionState.set(nextState);
  });

  attachedClients.add(client as object);
}

export async function connectToSurreal(client: SurrealLike = db): Promise<true> {
  const config = getEnvironmentConfig();

  attachConnectionListeners(client);
  connectionState.set('connecting');

  return client.connect(config.surrealUrl, {
    namespace: config.namespace,
    database: config.database,
    reconnect: {
      enabled: true,
      attempts: -1,
      retryDelay: 1_000,
      retryDelayMax: 30_000,
    },
  });
}

export function isTokens(value: unknown): value is Tokens {
  return typeof value === 'object' && value !== null && 'access' in value;
}
