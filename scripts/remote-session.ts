#!/usr/bin/env bun
// VPS 远程会话工具：用一次性兑换码换 IdP token、续期、取 SurrealDB workspace 连接。
// 仅标准 fetch/fs，无新依赖。用法：
//   bun scripts/remote-session.ts redeem '<链接>'
//   bun scripts/remote-session.ts token [--ops]
//   bun scripts/remote-session.ts db <workspace-slug>
//   bun scripts/remote-session.ts status
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const SESSION_PATH =
  process.env.SCK_REMOTE_SESSION
  ?? join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? ".", ".config"), "sck-remote", "session.json");
const LOCK_PATH = SESSION_PATH + ".lock";

interface SessionFile {
  issuer: string;
  clientId: string;
  api: string;
  aud: string;
  opsAud: string;
  refreshToken: string;
  dbUrl?: string;
}

const fail = (message: string): never => {
  console.error(`remote-session: ${message}`);
  process.exit(1);
};

export function parseRemoteLink(link: string): Omit<SessionFile, "refreshToken"> & { code: string } {
  const url = new URL(link.trim());
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const code = fragment.get("code") ?? fail("链接缺少 code 参数");
  const clientId = fragment.get("client_id") ?? fail("链接缺少 client_id 参数");
  const api = fragment.get("api") ?? fail("链接缺少 api 参数");
  const aud = fragment.get("aud") ?? fail("链接缺少 aud 参数");
  const opsAud = fragment.get("ops_aud") ?? aud;
  const dbUrl = fragment.get("db_url") ?? "wss://data.maplayer.top/rpc";
  const issuer = url.origin + url.pathname.replace(/\/remote$/, "");
  return { issuer, clientId, api, aud, opsAud, dbUrl, code };
}

async function readSession(): Promise<SessionFile> {
  if (!existsSync(SESSION_PATH)) fail(`会话文件不存在：${SESSION_PATH}（先 redeem）`);
  return JSON.parse(await readFile(SESSION_PATH, "utf8")) as SessionFile;
}

async function writeSession(session: SessionFile): Promise<void> {
  await mkdir(dirname(SESSION_PATH), { recursive: true, mode: 0o700 });
  const tmp = SESSION_PATH + ".tmp";
  await writeFile(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
  await rename(tmp, SESSION_PATH);
  await chmod(SESSION_PATH, 0o600).catch(() => undefined);
}

/** 锁文件串行化：refresh 单次轮换，并发重放会让 IdP 撤销整个 grant。 */
async function withLock<T>(work: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await writeFile(LOCK_PATH, String(process.pid), { flag: "wx", mode: 0o600 });
      break;
    } catch {
      if (Date.now() > deadline) fail("等待会话锁超时；可能另一个 remote-session 进程卡住了");
      await new Promise((resolve) => setTimeout(resolve, 120 + Math.random() * 120));
    }
  }
  try {
    return await work();
  } finally {
    await import("node:fs/promises").then((fs) => fs.unlink(LOCK_PATH).catch(() => undefined));
  }
}

const REQUEST_TIMEOUT_MS = 30_000;

export async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  try {
    // 兑换/refresh的表单与Bearer不得通过307/308等跳转发送到另一个端点。
    return await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(`请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒未响应）`);
    }
    throw new Error("认证网络请求失败或发生不允许的重定向");
  }
}

export function safeOAuthError(value: unknown): string {
  const known = ["invalid_grant", "invalid_client", "unauthorized_client", "invalid_request", "invalid_scope", "access_denied", "temporarily_unavailable", "server_error"];
  return typeof value === "string" && known.includes(value) ? value : "未知";
}

async function postForm(url: string, params: Record<string, string>) {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || body === null) {
    fail(`上游错误 HTTP ${response.status}：${safeOAuthError(body?.error)}`);
  }
  return body;
}

async function cmdRedeem(link: string) {
  const parsed = parseRemoteLink(link);
  const tokens = await postForm(`${parsed.issuer}/token`, {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token_type: "urn:ma-hono:params:oauth:token-type:remote-grant-code",
    subject_token: parsed.code,
    client_id: parsed.clientId,
    resource: parsed.aud,
  });
  if (typeof tokens.refresh_token !== "string") fail("兑换响应缺少 refresh_token");
  const session: SessionFile = {
    issuer: parsed.issuer, clientId: parsed.clientId, api: parsed.api,
    aud: parsed.aud, opsAud: parsed.opsAud, refreshToken: tokens.refresh_token,
    ...(parsed.dbUrl ? { dbUrl: parsed.dbUrl } : {}),
  };
  await writeSession(session);
  console.log(`会话已写入 ${SESSION_PATH}（issuer ${session.issuer}）`);
}

async function cmdToken(ops: boolean) {
  await withLock(async () => {
    const session = await readSession();
    const tokens = await postForm(`${session.issuer}/token`, {
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      client_id: session.clientId,
      resource: ops ? session.opsAud : session.aud,
    });
    if (typeof tokens.refresh_token === "string") {
      session.refreshToken = tokens.refresh_token;
      await writeSession(session); // 轮换后立刻持久化，避免旧票重放触发 grant 撤销
    }
    if (typeof tokens.access_token !== "string") fail("续期响应缺少 access_token");
    process.stdout.write(tokens.access_token);
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonemptyName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && value.trim() === value
    && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

/** 仅检查响应之间的一致性；不验证 JWT 签名，也不以 claim 作为授权或库名来源。 */
function scopeTokenMatchesDatabase(token: string, database: string): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
    const payload = parts[1];
    if (!payload) return false;
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.toString("base64url") !== payload) return false;
    const claims: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return isObject(claims) && claims.db === database;
  } catch {
    return false;
  }
}

export async function resolveWorkspaceConnection(api: string, token: string, slug: string) {
  if (!isNonemptyName(slug)) throw new Error("workspace slug 无效");
  const listResponse = await fetchWithTimeout(`${api}/api/session/workspaces`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  const list: unknown = await listResponse.json().catch(() => null);
  if (!listResponse.ok || !isObject(list) || !Array.isArray(list.workspaces)) {
    throw new Error("workspaces 响应无效");
  }
  const matches: string[] = [];
  for (const item of list.workspaces) {
    if (!isObject(item) || !isNonemptyName(item.slug) || !isNonemptyName(item.dbName)) {
      throw new Error("workspaces 条目无效");
    }
    if (item.slug === slug) matches.push(item.dbName);
  }
  const database = matches[0];
  if (matches.length !== 1 || !database) throw new Error("workspace 不存在或不唯一");

  const response = await fetchWithTimeout(`${api}/api/session/switch-workspace`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ workspaceSlug: slug }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !isObject(body) || body.ok !== true || typeof body.accessToken !== "string"
    || !scopeTokenMatchesDatabase(body.accessToken, database)) {
    throw new Error("switch-workspace 响应无效或数据库不一致");
  }
  let expiresAt: string | null = null;
  if (body.expiresIn !== null) {
    if (typeof body.expiresIn !== "number" || !Number.isFinite(body.expiresIn) || body.expiresIn <= 0) {
      throw new Error("switch-workspace 有效期无效");
    }
    const expiry = new Date(Date.now() + body.expiresIn * 1000);
    if (!Number.isFinite(expiry.getTime())) throw new Error("switch-workspace 有效期无效");
    expiresAt = expiry.toISOString();
  }
  return { database, token: body.accessToken, expiresAt };
}

async function cmdDb(slug: string) {
  const session = await readSession();
  const token = await refreshAccessToken(session, false);
  // 不回显上游响应、token、库名或底层异常；失败时 stdout 不产生连接信息。
  const connection = await resolveWorkspaceConnection(session.api, token, slug)
    .catch(() => fail("无法取得一致的 workspace 连接；请检查会话与 workspace 配置"));
  process.stdout.write(JSON.stringify({
    url: session.dbUrl ?? "wss://data.maplayer.top/rpc",
    namespace: "main",
    ...connection,
  }));
}

async function refreshAccessToken(session: SessionFile, ops: boolean): Promise<string> {
  return withLock(async () => {
    const current = await readSession();
    const tokens = await postForm(`${current.issuer}/token`, {
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: current.clientId,
      resource: ops ? current.opsAud : current.aud,
    });
    if (typeof tokens.refresh_token === "string") {
      current.refreshToken = tokens.refresh_token;
      await writeSession(current);
    }
    if (typeof tokens.access_token !== "string") fail("续期响应缺少 access_token");
    return tokens.access_token;
  });
}

async function cmdStatus() {
  const session = await readSession();
  console.log(JSON.stringify({
    issuer: session.issuer,
    clientId: session.clientId,
    api: session.api,
    aud: session.aud,
    opsAud: session.opsAud,
    sessionPath: SESSION_PATH,
  }, null, 2));
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "redeem" && args[0]) await cmdRedeem(args[0]);
  else if (command === "token") await cmdToken(args.includes("--ops"));
  else if (command === "db" && args[0]) await cmdDb(args[0]);
  else if (command === "status") await cmdStatus();
  else fail("用法：redeem <链接> | token [--ops] | db <workspace-slug> | status");
}
