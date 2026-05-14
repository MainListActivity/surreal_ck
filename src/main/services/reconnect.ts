import { DateTime } from "surrealdb";
import { getLocalDb, getRemoteDb, connectRemote } from "../db/index";
import { refreshAccessToken } from "../auth/oidc";
import { omitNullishSurrealFields } from "../db/surreal-values";
import { activateSession } from "../auth/session";
import { setOfflineMode } from "./offline-state";
import { setSyncLastError } from "../sync/status";

/**
 * 重连流程的结果类型。
 * - reconnected：远端连接已恢复
 * - offline：仍然离线（通常是网络问题），下次可继续重试
 * - needs-relogin：refresh_token 已失效，必须重新走 OIDC 登录
 */
export type ReconnectOutcome =
  | { status: "reconnected" }
  | { status: "offline"; message: string }
  | { status: "needs-relogin"; message: string };

let _needsRelogin = false;
let _reconnecting = false;

export function getNeedsRelogin(): boolean {
  return _needsRelogin;
}

export function getReconnecting(): boolean {
  return _reconnecting;
}

export function clearNeedsReloginForTests(): void {
  _needsRelogin = false;
  _reconnecting = false;
}

/** refresh_token 端点常见的不可恢复错误（4xx + invalid_grant），表示需要重新登录。 */
function isUnrecoverableRefreshError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (/Token refresh failed \((4\d\d)\)/.test(message)) return true;
  if (/invalid_grant|invalid_token|unauthorized_client/i.test(message)) return true;
  return false;
}

/**
 * 幂等地尝试恢复 remote 连接：
 * 1. 已经在线 → 直接返回 reconnected
 * 2. 读取 token_store；access_token 仍有效 → 直接 connectRemote
 * 3. 否则用 refresh_token 换新 token，写回 token_store 后 connectRemote
 * 4. refresh_token 失效或缺失 → 进入 needs-relogin 终态
 */
export async function reconnectRemote(): Promise<ReconnectOutcome> {
  if (_reconnecting) {
    return { status: "offline", message: "重连进行中" };
  }
  if (_needsRelogin) {
    return { status: "needs-relogin", message: "refresh_token 已失效，请重新登录" };
  }

  _reconnecting = true;
  try {
    if (getRemoteDb()) {
      setOfflineMode(false);
      setSyncLastError(undefined);
      return { status: "reconnected" };
    }

    let db;
    try {
      db = getLocalDb();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "offline", message };
    }

    const rows = await db.query<[{ access_token?: string; refresh_token?: string; expires_at?: DateTime }[]]>(
      `SELECT access_token, refresh_token, expires_at FROM token_store:local`
    );
    const stored = rows[0]?.[0];

    if (!stored?.access_token && !stored?.refresh_token) {
      _needsRelogin = true;
      const message = "本地未保存登录凭据";
      setSyncLastError(message);
      return { status: "needs-relogin", message };
    }

    const expiresAt = stored?.expires_at instanceof DateTime
      ? stored.expires_at.toDate().getTime()
      : stored?.expires_at
        ? new Date(stored.expires_at as unknown as string).getTime()
        : 0;
    const fiveMinutes = 5 * 60 * 1000;
    const accessTokenValid =
      !!stored?.access_token &&
      Number.isFinite(expiresAt) &&
      Date.now() < expiresAt - fiveMinutes;

    let accessToken: string;
    let newExpiresAt: number;

    if (accessTokenValid) {
      accessToken = stored!.access_token!;
      newExpiresAt = expiresAt;
    } else {
      if (!stored?.refresh_token) {
        _needsRelogin = true;
        const message = "本地未保存 refresh_token，需重新登录";
        setSyncLastError(message);
        return { status: "needs-relogin", message };
      }
      try {
        const newTokens = await refreshAccessToken(stored.refresh_token);
        newExpiresAt = Date.now() + newTokens.expires_in * 1000;
        accessToken = newTokens.access_token;
        await db.query(
          `UPSERT token_store:local CONTENT $content`,
          {
            content: omitNullishSurrealFields({
              access_token: newTokens.access_token,
              refresh_token: newTokens.refresh_token ?? stored.refresh_token,
              expires_at: new DateTime(new Date(newExpiresAt)),
            }),
          }
        );
        activateSession(newExpiresAt);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isUnrecoverableRefreshError(err)) {
          _needsRelogin = true;
          setSyncLastError(`refresh_token 失效：${message}`);
          return { status: "needs-relogin", message };
        }
        setSyncLastError(`刷新令牌失败：${message}`);
        return { status: "offline", message };
      }
    }

    await connectRemote(accessToken);

    if (!getRemoteDb()) {
      // connectRemote 内部已经把错误写入 syncLastError
      return { status: "offline", message: "远端连接失败" };
    }

    return { status: "reconnected" };
  } finally {
    _reconnecting = false;
  }
}
