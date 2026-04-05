/// <reference types="vite/client" />

import { useSyncExternalStore } from 'react';

import type {
  AuthPendingLogin,
  AuthSnapshot,
  AuthStatus,
  JwtClaims,
  OidcConfig,
  OidcTokenBundle,
  SessionStorageLike,
  TokenEndpointResponse,
  UserProfile,
} from '../../lib/surreal/types';

const DEFAULT_ACCESS_REFRESH_LEEWAY_MS = 60_000;
const TOKEN_STORAGE_KEY = 'surreal_ck.oidc.tokens';
const LOGIN_STORAGE_KEY = 'surreal_ck.oidc.login';
const CALLBACK_PATH = '/callback';

type Listener = (snapshot: AuthSnapshot) => void;
type FetchLike = typeof fetch;

class AuthStateStore {
  #snapshot: AuthSnapshot = {
    status: 'checking',
    isLoggedIn: false,
    updatedAt: Date.now(),
  };

  #listeners = new Set<Listener>();

  getSnapshot(): AuthSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    listener(this.#snapshot);

    return () => {
      this.#listeners.delete(listener);
    };
  }

  set(status: AuthStatus, detail?: Pick<AuthSnapshot, 'error' | 'user'>): void {
    this.#snapshot = {
      status,
      isLoggedIn: status === 'authenticated',
      error: detail?.error,
      user: detail?.user,
      updatedAt: Date.now(),
    };

    for (const listener of this.#listeners) {
      listener(this.#snapshot);
    }
  }
}

const authState = new AuthStateStore();

function resolveStorage(): SessionStorageLike | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.localStorage;
}

function base64UrlEncode(value: Uint8Array): string {
  let encoded = '';

  for (const byte of value) {
    encoded += String.fromCharCode(byte);
  }

  return btoa(encoded).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return atob(`${normalized}${padding}`);
}

function decodeJwtPayload(token: string): JwtClaims | null {
  const [, payload] = token.split('.');

  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(base64UrlDecode(payload)) as JwtClaims;
  } catch {
    return null;
  }
}

function getTokenExpiry(token: string): number | null {
  const claims = decodeJwtPayload(token);
  return claims?.exp ? claims.exp * 1_000 : null;
}

function deriveUserProfile(bundle: OidcTokenBundle): UserProfile | undefined {
  const claims = decodeJwtPayload(bundle.idToken ?? bundle.accessToken);

  if (!claims?.sub) {
    return undefined;
  }

  return {
    sub: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : undefined,
    name:
      typeof claims.name === 'string'
        ? claims.name
        : typeof claims.preferred_username === 'string'
          ? claims.preferred_username
          : undefined,
    recordId: `app_user:${claims.sub}`,
  };
}

function readStoredJson<T>(
  storageKey: string,
  storage: SessionStorageLike | null = resolveStorage(),
): T | null {
  const raw = storage?.getItem(storageKey);

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    storage?.removeItem(storageKey);
    return null;
  }
}

function writeStoredJson<T>(
  storageKey: string,
  value: T,
  storage: SessionStorageLike | null = resolveStorage(),
): void {
  storage?.setItem(storageKey, JSON.stringify(value));
}

export function getOidcConfig(
  env: ImportMetaEnv | Record<string, string | undefined> = import.meta.env,
): OidcConfig {
  const fallbackRedirectUri =
    typeof window === 'undefined' ? `http://localhost:5173${CALLBACK_PATH}` : `${window.location.origin}${CALLBACK_PATH}`;

  return {
    issuer: env.VITE_OIDC_ISSUER ?? 'https://o.maplayer.top/t/ck',
    authorizationEndpoint: env.VITE_OIDC_AUTHORIZATION_ENDPOINT ?? 'https://o.maplayer.top/t/ck/authorize',
    tokenEndpoint: env.VITE_OIDC_TOKEN_ENDPOINT ?? 'https://o.maplayer.top/t/ck/token',
    jwksUrl: env.VITE_OIDC_JWKS_URL ?? 'https://o.maplayer.top/t/ck/jwks.json',
    clientId: env.VITE_OIDC_CLIENT_ID ?? 'b10df483-1cd4-4beb-8a01-92e8f4b3fdf4',
    audience: env.VITE_OIDC_AUDIENCE ?? 'https://auth.maplayer.top',
    scope: env.VITE_OIDC_SCOPE ?? 'openid profile email',
    redirectUri: env.VITE_OIDC_REDIRECT_URI ?? fallbackRedirectUri,
  };
}

export function getStoredTokens(
  storage: SessionStorageLike | null = resolveStorage(),
): OidcTokenBundle | null {
  return readStoredJson<OidcTokenBundle>(TOKEN_STORAGE_KEY, storage);
}

export function persistTokens(
  bundle: OidcTokenBundle,
  storage: SessionStorageLike | null = resolveStorage(),
): void {
  writeStoredJson(TOKEN_STORAGE_KEY, bundle, storage);
}

export function clearTokens(storage: SessionStorageLike | null = resolveStorage()): void {
  storage?.removeItem(TOKEN_STORAGE_KEY);
}

function getPendingLogin(
  storage: SessionStorageLike | null = resolveStorage(),
): AuthPendingLogin | null {
  return readStoredJson<AuthPendingLogin>(LOGIN_STORAGE_KEY, storage);
}

function persistPendingLogin(
  payload: AuthPendingLogin,
  storage: SessionStorageLike | null = resolveStorage(),
): void {
  writeStoredJson(LOGIN_STORAGE_KEY, payload, storage);
}

function clearPendingLogin(storage: SessionStorageLike | null = resolveStorage()): void {
  storage?.removeItem(LOGIN_STORAGE_KEY);
}

function isOidcCallbackUrl(url: URL = new URL(window.location.href)): boolean {
  return url.pathname === CALLBACK_PATH;
}

function getDefaultReturnTo(url: URL = new URL(window.location.href)): string {
  return url.pathname === CALLBACK_PATH ? '/' : `${url.pathname}${url.search}${url.hash}`;
}

async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64UrlEncode(verifierBytes);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(digest));
  return { verifier, challenge };
}

function createStateToken(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(24)));
}

function buildTokenBundle(payload: TokenEndpointResponse): OidcTokenBundle {
  const now = Date.now();
  const accessExpiresAt = payload.expires_in
    ? now + payload.expires_in * 1_000
    : getTokenExpiry(payload.access_token) ?? now + 3_600_000;
  const refreshExpiresAt = payload.refresh_token ? getTokenExpiry(payload.refresh_token) : null;

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    idToken: payload.id_token,
    tokenType: payload.token_type,
    scope: payload.scope,
    accessExpiresAt,
    refreshExpiresAt: refreshExpiresAt ?? undefined,
    issuedAt: now,
  };
}

async function exchangeCodeForTokens(
  code: string,
  verifier: string,
  fetcher: FetchLike = fetch,
): Promise<OidcTokenBundle> {
  const config = getOidcConfig();
  const response = await fetcher(config.tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
    }),
  });

  if (!response.ok) {
    throw new Error(`OIDC token exchange failed (${response.status})`);
  }

  return buildTokenBundle((await response.json()) as TokenEndpointResponse);
}

async function refreshAccessToken(
  refreshToken: string,
  fetcher: FetchLike = fetch,
): Promise<OidcTokenBundle> {
  const config = getOidcConfig();
  const response = await fetcher(config.tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: config.clientId,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error(`OIDC refresh failed (${response.status})`);
  }

  return buildTokenBundle((await response.json()) as TokenEndpointResponse);
}

function leaveAuthCallback(returnTo = '/'): void {
  if (typeof window === 'undefined') {
    return;
  }

  const nextUrl = new URL(returnTo, window.location.origin);
  window.history.replaceState({}, document.title, `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
}

function syncAuthState(bundle: OidcTokenBundle | null): void {
  if (!bundle) {
    authState.set('unauthenticated');
    return;
  }

  authState.set('authenticated', { user: deriveUserProfile(bundle) });
}

class OidcAuthGateway {
  #bootstrapPromise: Promise<void> | null = null;

  async bootstrap(fetcher: FetchLike = fetch): Promise<void> {
    if (this.#bootstrapPromise) {
      return this.#bootstrapPromise;
    }

    this.#bootstrapPromise = (async () => {
      if (typeof window === 'undefined') {
        authState.set('unauthenticated');
        return;
      }

      const url = new URL(window.location.href);
      const params = url.searchParams;

      if (isOidcCallbackUrl(url) && params.get('error')) {
        authState.set('error', {
          error: params.get('error_description') ?? params.get('error') ?? 'OIDC login failed',
        });
        return;
      }

      if (isOidcCallbackUrl(url) && params.get('code') && params.get('state')) {
        const returnTo = await this.handleCallback(params.get('code') ?? '', params.get('state') ?? '', fetcher);
        leaveAuthCallback(returnTo);
        return;
      }

      try {
        const token = await this.validAccessToken(fetcher);

        if (token) {
          syncAuthState(getStoredTokens());
          return;
        }

        authState.set('unauthenticated');
      } catch (error) {
        await this.logout();
        authState.set('error', { error: error instanceof Error ? error.message : 'Session restore failed' });
      }
    })();

    try {
      await this.#bootstrapPromise;
    } finally {
      this.#bootstrapPromise = null;
    }
  }

  async startLogin(
    storage: SessionStorageLike | null = resolveStorage(),
    navigate = true,
  ): Promise<string> {
    authState.set('authorizing');

    const config = getOidcConfig();
    const { verifier, challenge } = await createPkcePair();
    const state = createStateToken();

    persistPendingLogin(
      {
        state,
        codeVerifier: verifier,
        redirectUri: config.redirectUri,
        returnTo:
          typeof window === 'undefined' ? '/' : getDefaultReturnTo(new URL(window.location.href)),
        createdAt: Date.now(),
      },
      storage,
    );

    const authorizeUrl = new URL(config.authorizationEndpoint);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', config.clientId);
    authorizeUrl.searchParams.set('redirect_uri', config.redirectUri);
    authorizeUrl.searchParams.set('scope', config.scope);
    authorizeUrl.searchParams.set('audience', config.audience);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('state', state);

    if (navigate && typeof window !== 'undefined') {
      window.location.assign(authorizeUrl.toString());
    }

    return authorizeUrl.toString();
  }

  async handleCallback(
    code: string,
    state: string,
    fetcher: FetchLike = fetch,
    storage: SessionStorageLike | null = resolveStorage(),
  ): Promise<string> {
    authState.set('authorizing');

    const pending = getPendingLogin(storage);

    if (!pending || pending.state !== state) {
      clearPendingLogin(storage);
      throw new Error('OIDC state validation failed');
    }

    const bundle = await exchangeCodeForTokens(code, pending.codeVerifier, fetcher);
    persistTokens(bundle, storage);
    clearPendingLogin(storage);
    syncAuthState(bundle);
    return pending.returnTo || '/';
  }

  async validAccessToken(
    fetcher: FetchLike = fetch,
    storage: SessionStorageLike | null = resolveStorage(),
  ): Promise<string | null> {
    const bundle = getStoredTokens(storage);

    if (!bundle) {
      return null;
    }

    const refreshDeadline = bundle.accessExpiresAt - DEFAULT_ACCESS_REFRESH_LEEWAY_MS;

    if (Date.now() < refreshDeadline) {
      return bundle.accessToken;
    }

    if (!bundle.refreshToken) {
      clearTokens(storage);
      authState.set('unauthenticated');
      return null;
    }

    const refreshed = await refreshAccessToken(bundle.refreshToken, fetcher);
    const mergedBundle: OidcTokenBundle = {
      ...bundle,
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? bundle.refreshToken,
      idToken: refreshed.idToken ?? bundle.idToken,
    };

    persistTokens(mergedBundle, storage);
    syncAuthState(mergedBundle);
    return mergedBundle.accessToken;
  }

  async logout(storage: SessionStorageLike | null = resolveStorage()): Promise<void> {
    clearPendingLogin(storage);
    clearTokens(storage);
    authState.set('unauthenticated');
  }
}

export const authGateway = new OidcAuthGateway();

export function useAuthSnapshot(): AuthSnapshot {
  return useSyncExternalStore(
    (listener) => authState.subscribe(listener),
    () => authState.getSnapshot(),
    () => authState.getSnapshot(),
  );
}

export async function bootstrapAuth(fetcher?: FetchLike): Promise<void> {
  await authGateway.bootstrap(fetcher);
}
