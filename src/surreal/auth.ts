import type { Tokens } from 'surrealdb';

import { connectionState, getEnvironmentConfig, surreal, type SurrealLike } from './client';
import type { SessionStorageLike } from './types';

const STORAGE_KEY = 'surreal_ck.auth.tokens';

const resolveStorage = (): SessionStorageLike | null => {
  if (typeof window === 'undefined' || !window.sessionStorage) {
    return null;
  }

  return window.sessionStorage;
};

export function getTokens(storage: SessionStorageLike | null = resolveStorage()): Tokens | null {
  const raw = storage?.getItem(STORAGE_KEY);

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Tokens;

    if (!parsed.access) {
      return null;
    }

    return parsed;
  } catch {
    storage?.removeItem(STORAGE_KEY);
    return null;
  }
}

export function persistTokens(tokens: Tokens, storage: SessionStorageLike | null = resolveStorage()): void {
  storage?.setItem(STORAGE_KEY, JSON.stringify(tokens));
}

export function clearTokens(storage: SessionStorageLike | null = resolveStorage()): void {
  storage?.removeItem(STORAGE_KEY);
}

export async function signIn(
  email: string,
  password: string,
  client: SurrealLike = surreal,
  storage: SessionStorageLike | null = resolveStorage(),
): Promise<Tokens> {
  const config = getEnvironmentConfig();

  connectionState.set('connecting');

  const tokens = await client.signin({
    namespace: config.namespace,
    database: config.database,
    access: config.authAccess,
    variables: {
      email,
      password,
    },
  });

  persistTokens(tokens, storage);
  connectionState.set('connected');

  return tokens;
}

export async function restoreSession(
  client: SurrealLike = surreal,
  storage: SessionStorageLike | null = resolveStorage(),
): Promise<Tokens | null> {
  const tokens = getTokens(storage);

  if (!tokens) {
    return null;
  }

  try {
    connectionState.set('connecting');
    const refreshed = await client.authenticate(tokens);
    persistTokens(refreshed, storage);
    connectionState.set('connected');
    return refreshed;
  } catch (error) {
    clearTokens(storage);
    connectionState.set('disconnected', error instanceof Error ? error.message : 'Session invalid');
    return null;
  }
}

export async function signOut(
  client: SurrealLike = surreal,
  storage: SessionStorageLike | null = resolveStorage(),
): Promise<void> {
  try {
    await client.invalidate();
  } finally {
    clearTokens(storage);
    connectionState.set('disconnected');
  }
}
