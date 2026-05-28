import { UserManager, WebStorageStateStore } from "oidc-client-ts";
import type { SigninRedirectArgs, User } from "oidc-client-ts";

export type AuthAccess = "admin" | "participant";

export type AuthClaims = {
  sub: string;
  email: string;
  name?: string;
  "https://surrealdb.com/db": string;
  "https://surrealdb.com/ac": AuthAccess;
};

type AuthClientOptions = {
  storage?: Storage;
  now?: () => Date;
  userManager?: AuthUserManager;
  currentPath?: () => string;
  navigate?: (url: string) => void;
};

export type AuthClient = {
  getToken(): string | null;
  getClaims(): AuthClaims | null;
  isAuthenticated(): boolean;
  handleCallback(currentUrl?: string): Promise<AuthCallbackResult>;
  refresh(): Promise<string | null>;
  logout(): Promise<void>;
  requireAuthenticatedRoute(path?: string): boolean;
  login(returnTo?: string): Promise<void>;
};

export type AuthCallbackResult =
  | { ok: true; returnTo: string }
  | { ok: false; error: string };

type AuthUser = {
  access_token?: string;
  id_token?: string;
  expires_at?: number;
  profile?: unknown;
  state?: unknown;
};

type AuthUserManager = {
  signinRedirect?(args?: Pick<SigninRedirectArgs, "state">): Promise<void>;
  signinRedirectCallback?(url?: string): Promise<AuthUser>;
  signinSilent?(): Promise<AuthUser | null>;
  signoutRedirect?(): Promise<void>;
};

const ACCESS_TOKEN_KEY = "oidc.access_token";
const ID_TOKEN_KEY = "oidc.id_token";
const EXP_KEY = "oidc.exp";
const CLAIMS_KEY = "oidc.claims";
const REFRESH_SKEW_MS = 5 * 60 * 1000;

type ViteEnv = Partial<{
  VITE_OIDC_ISSUER: string;
  VITE_OIDC_CLIENT_ID: string;
  VITE_OIDC_REDIRECT_URI: string;
  VITE_OIDC_AUDIENCE: string;
}>;

let browserManager: UserManager | undefined;

function browserStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.sessionStorage;
}

function readJson<T>(storage: Storage | undefined, key: string): T | null {
  const raw = storage?.getItem(key);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function currentHref(): string {
  if (typeof window === "undefined") return "";
  return window.location.href;
}

function browserPath(): string {
  if (typeof window === "undefined") return "/";
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function browserNavigate(url: string): void {
  if (typeof window !== "undefined") window.location.assign(url);
}

function viteEnv(): ViteEnv {
  return ((import.meta as ImportMeta & { env?: ViteEnv }).env ?? {}) as ViteEnv;
}

function browserOrigin(): string {
  if (typeof window === "undefined") return "";
  return window.location.origin;
}

function createBrowserUserManager(): UserManager | undefined {
  if (typeof window === "undefined") return undefined;
  if (browserManager) return browserManager;

  const env = viteEnv();
  const authority = env.VITE_OIDC_ISSUER;
  const clientId = env.VITE_OIDC_CLIENT_ID;
  const redirectUri = env.VITE_OIDC_REDIRECT_URI;
  const audience = env.VITE_OIDC_AUDIENCE;

  if (!authority || !clientId || !redirectUri || !audience) return undefined;

  browserManager = new UserManager({
    authority,
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile email offline_access",
    silent_redirect_uri: redirectUri,
    post_logout_redirect_uri: browserOrigin(),
    automaticSilentRenew: false,
    includeIdTokenInSilentRenew: true,
    extraQueryParams: { audience },
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  });

  return browserManager;
}

function loginUrl(returnTo: string): string {
  return `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

function isAuthRoute(path: string): boolean {
  return path.startsWith("/auth/login") || path.startsWith("/auth/callback");
}

function clearStoredSession(storage: Storage | undefined): void {
  storage?.removeItem(ACCESS_TOKEN_KEY);
  storage?.removeItem(ID_TOKEN_KEY);
  storage?.removeItem(EXP_KEY);
  storage?.removeItem(CLAIMS_KEY);
}

function isClaims(value: unknown): value is AuthClaims {
  if (!value || typeof value !== "object") return false;
  const claims = value as Partial<AuthClaims>;

  return (
    typeof claims.sub === "string" &&
    typeof claims.email === "string" &&
    typeof claims["https://surrealdb.com/db"] === "string" &&
    (claims["https://surrealdb.com/ac"] === "admin" ||
      claims["https://surrealdb.com/ac"] === "participant")
  );
}

function returnToFromState(state: unknown): string {
  if (!state || typeof state !== "object") return "/";
  const returnTo = (state as { returnTo?: unknown }).returnTo;
  return typeof returnTo === "string" && returnTo.startsWith("/") ? returnTo : "/";
}

function callbackErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function persistUser(storage: Storage | undefined, user: AuthUser): string | null {
  if (!user.access_token || !user.expires_at || !isClaims(user.profile)) {
    clearStoredSession(storage);
    return null;
  }

  storage?.setItem(ACCESS_TOKEN_KEY, user.access_token);
  if (user.id_token) storage?.setItem(ID_TOKEN_KEY, user.id_token);
  storage?.setItem(EXP_KEY, String(user.expires_at));
  storage?.setItem(CLAIMS_KEY, JSON.stringify(user.profile));

  return user.access_token;
}

export function createAuthClient(options: AuthClientOptions = {}): AuthClient {
  const storage = options.storage ?? browserStorage();
  const now = options.now ?? (() => new Date());
  const userManager = options.userManager ?? createBrowserUserManager();
  const currentPath = options.currentPath ?? browserPath;
  const navigate = options.navigate ?? browserNavigate;

  function redirectToLogin(): void {
    navigate(loginUrl(currentPath()));
  }

  function isCurrentAuthenticated(): boolean {
    const token = storage?.getItem(ACCESS_TOKEN_KEY);
    const exp = Number(storage?.getItem(EXP_KEY));
    return Boolean(token && Number.isFinite(exp) && exp * 1000 > now().getTime());
  }

  return {
    getToken() {
      return storage?.getItem(ACCESS_TOKEN_KEY) ?? null;
    },
    getClaims() {
      return readJson<AuthClaims>(storage, CLAIMS_KEY);
    },
    isAuthenticated() {
      return isCurrentAuthenticated();
    },
    async handleCallback(currentUrl = currentHref()) {
      let url: URL;
      try {
        url = new URL(currentUrl);
      } catch {
        return { ok: false, error: "OIDC callback URL is invalid" };
      }

      const callbackError = url.searchParams.get("error");
      if (callbackError) {
        return {
          ok: false,
          error: url.searchParams.get("error_description") ?? callbackError,
        };
      }

      if (!url.searchParams.has("code") || !url.searchParams.has("state")) {
        return { ok: false, error: "OIDC callback is missing code or state" };
      }

      if (!userManager?.signinRedirectCallback) {
        return { ok: false, error: "OIDC client is not configured" };
      }

      try {
        const user = (await userManager.signinRedirectCallback(currentUrl)) as User;
        const accessToken = persistUser(storage, user);
        if (!accessToken) return { ok: false, error: "OIDC callback did not return a complete session" };

        return { ok: true, returnTo: returnToFromState(user.state) };
      } catch (error) {
        clearStoredSession(storage);
        return { ok: false, error: callbackErrorMessage(error) };
      }
    },
    async refresh() {
      const token = storage?.getItem(ACCESS_TOKEN_KEY) ?? null;
      const exp = Number(storage?.getItem(EXP_KEY));
      if (!token || !Number.isFinite(exp)) return null;

      const expiresAt = exp * 1000;
      if (expiresAt - now().getTime() > REFRESH_SKEW_MS) return token;

      if (!userManager?.signinSilent) {
        clearStoredSession(storage);
        redirectToLogin();
        return null;
      }

      try {
        const user = await userManager.signinSilent();
        const accessToken = user ? persistUser(storage, user) : null;
        if (accessToken) return accessToken;

        clearStoredSession(storage);
        redirectToLogin();
        return null;
      } catch {
        clearStoredSession(storage);
        redirectToLogin();
        return null;
      }
    },
    async logout() {
      clearStoredSession(storage);
      if (userManager?.signoutRedirect) await userManager.signoutRedirect();
    },
    requireAuthenticatedRoute(path = currentPath()) {
      if (isAuthRoute(path) || isCurrentAuthenticated()) return true;
      navigate(loginUrl(path));
      return false;
    },
    async login(returnTo = currentPath()) {
      if (!userManager?.signinRedirect) throw new Error("OIDC client is not configured");
      await userManager.signinRedirect({ state: { returnTo } });
    },
  };
}

const defaultAuth = createAuthClient();

export function getToken(): string | null {
  return defaultAuth.getToken();
}

export function getClaims(): AuthClaims | null {
  return defaultAuth.getClaims();
}

export function isAuthenticated(): boolean {
  return defaultAuth.isAuthenticated();
}

export function handleCallback(currentUrl?: string): Promise<AuthCallbackResult> {
  return defaultAuth.handleCallback(currentUrl);
}

export function refresh(): Promise<string | null> {
  return defaultAuth.refresh();
}

export function logout(): Promise<void> {
  return defaultAuth.logout();
}

export function requireAuthenticatedRoute(path?: string): boolean {
  return defaultAuth.requireAuthenticatedRoute(path);
}

export function login(returnTo?: string): Promise<void> {
  return defaultAuth.login(returnTo);
}
