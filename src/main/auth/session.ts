import { DateTime } from "surrealdb";
import type { TokenSet } from "./oidc";
import { refreshAccessToken } from "./oidc";
import { getLocalDb } from "../db/index";

// 内存层只存过期时间，用于快速判断是否需要刷新，避免每次都查 DB
let _expiresAt: number | null = null;

/**
 * 登录成功后调用，更新内存层过期时间。
 * tokens 的持久化由 initUserDb / tryRestoreSession 负责写入 token_store。
 */
export function loginToSurrealDB(tokens: TokenSet): void {
  _expiresAt = Date.now() + tokens.expires_in * 1000;
  console.log("[auth] session activated");
}

/**
 * 检查 session 是否有效，距过期 5 分钟内自动刷新。
 * 刷新成功后写回 token_store:local，防止 rotating refresh token 场景下冷启动失败。
 */
export async function ensureValidSession(): Promise<boolean> {
  if (_expiresAt === null) return false;

  const fiveMinutes = 5 * 60 * 1000;
  if (Date.now() < _expiresAt - fiveMinutes) return true;

  // 从 DB 读取 refresh_token
  let refreshToken: string | undefined;
  try {
    const db = getLocalDb();
    const rows = await db.query<[{ refresh_token?: string }[]]>(
      `SELECT refresh_token FROM token_store:local`
    );
    refreshToken = rows[0]?.[0]?.refresh_token;
  } catch {
    _expiresAt = null;
    return false;
  }

  if (!refreshToken) {
    _expiresAt = null;
    return false;
  }

  try {
    const newTokens = await refreshAccessToken(refreshToken);

    // 写回 token_store（rotating refresh token 必须更新）
    const db = getLocalDb();
    await db.query(
      `UPSERT token_store:local CONTENT {
        access_token: $access_token,
        refresh_token: $refresh_token,
        expires_at: $expires_at
      }`,
      {
        access_token: newTokens.access_token,
        refresh_token: newTokens.refresh_token ?? null,
        expires_at: new DateTime(new Date(Date.now() + newTokens.expires_in * 1000)),
      }
    );

    _expiresAt = Date.now() + newTokens.expires_in * 1000;
    console.log("[auth] token refreshed and persisted");
    return true;
  } catch (err) {
    console.warn("[auth] token refresh failed, clearing session:", err);
    _expiresAt = null;
    return false;
  }
}

export function clearSession(): void {
  _expiresAt = null;
}

export function getSession(): { expiresAt: number } | null {
  if (_expiresAt === null) return null;
  return { expiresAt: _expiresAt };
}

export function getPublicAuthState(opts?: { offlineMode?: boolean }): {
  loggedIn: boolean;
  expiresAt?: number;
  offlineMode?: boolean;
} {
  if (_expiresAt === null) {
    return { loggedIn: false, ...(opts?.offlineMode ? { offlineMode: true } : {}) };
  }
  return { loggedIn: true, expiresAt: _expiresAt };
}
