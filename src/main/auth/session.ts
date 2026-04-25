import { Surreal } from "surrealdb";
import type { TokenSet, OIDCSession } from "./oidc";
import { refreshAccessToken } from "./oidc";

let _session: OIDCSession | null = null;

/**
 * 用 OIDC access_token 认证 SurrealDB。
 * SurrealDB 的 `DEFINE ACCESS madocs TYPE RECORD WITH JWT` 会验证签名并执行
 * AUTHENTICATE 块（自动创建 app_user、认领邀请、创建默认 workspace）。
 */
export async function loginToSurrealDB(
  db: Surreal,
  tokens: TokenSet
): Promise<OIDCSession> {
  await db.authenticate(tokens.access_token);

  const session: OIDCSession = {
    tokens,
    expires_at: Date.now() + tokens.expires_in * 1000,
  };
  _session = session;
  console.log("[auth] SurrealDB authenticated via JWT");
  return session;
}

/**
 * 检查 session 是否有效，距过期 5 分钟内自动刷新。
 */
export async function ensureValidSession(
  db: Surreal
): Promise<OIDCSession | null> {
  if (!_session) return null;

  const fiveMinutes = 5 * 60 * 1000;
  if (Date.now() < _session.expires_at - fiveMinutes) {
    return _session;
  }

  if (!_session.tokens.refresh_token) {
    _session = null;
    return null;
  }

  try {
    const newTokens = await refreshAccessToken(_session.tokens.refresh_token);
    return loginToSurrealDB(db, newTokens);
  } catch (err) {
    console.warn("[auth] token refresh failed, clearing session:", err);
    _session = null;
    return null;
  }
}

export function clearSession(): void {
  _session = null;
}

export function getSession(): OIDCSession | null {
  return _session;
}

/** 返回 WebView 安全的认证状态（不含原始 token） */
export function getPublicAuthState(): {
  loggedIn: boolean;
  expiresAt?: number;
} {
  if (!_session) return { loggedIn: false };
  return {
    loggedIn: true,
    expiresAt: _session.expires_at,
  };
}
