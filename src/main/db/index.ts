import { existsSync } from "node:fs";
import { join } from "node:path";
import { Surreal, DateTime } from "surrealdb";
import { createNodeEngines } from "@surrealdb/node";
import type { TokenSet } from "../auth/oidc";
import { refreshAccessToken } from "../auth/oidc";

// ─── 状态 ────────────────────────────────────────────────────────────────────

let _engine: Surreal | null = null;
let _metaSession: Awaited<ReturnType<Surreal["newSession"]>> | null = null;
let _userDbName: string | null = null;
let _remoteDb: Surreal | null = null;
let _loginInProgress = false;

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

export function userDbName(sub: string): string {
  // Bun.hash.wyhash() 确定返回 bigint，避免 number | bigint 联合类型的歧义
  return `u_${Bun.hash.wyhash(sub).toString(16).padStart(16, "0")}`;
}

/** 从 schema 文件中 strip 掉 OPTION IMPORT + USE 头部，避免执行时切换 DB。
 *  验证结论：OPTION IMPORT 不忽略 USE 语句，必须手动移除。 */
function stripSchemaHeader(raw: string): string {
  return raw
    .replace(/^OPTION\s+IMPORT\s*;?\s*/im, "")
    .replace(/^USE\s+NS\s+\S+\s+DB\s+\S+\s*;?\s*/im, "");
}

async function loadSchema(db: Surreal): Promise<void> {
  const schemaPath = [
    // Electrobun bundle: Contents/Resources/app/bun/schema/main.surql
    join(import.meta.dir, "schema/main.surql"),
    // Source/test execution: src/main/db -> schema/main.surql
    join(import.meta.dir, "../../../schema/main.surql"),
    join(process.cwd(), "schema/main.surql"),
  ].find((path) => existsSync(path));

  if (!schemaPath) {
    throw new Error("[db] schema/main.surql not found");
  }

  const schemaRaw = await Bun.file(schemaPath).text();
  const schema = stripSchemaHeader(schemaRaw).replace(/DEFINE BUCKET[^;]*;/gs, "");
  await db.query(schema);
}

// ─── 生命周期 API ─────────────────────────────────────────────────────────────

/**
 * 步骤 1：进程启动时调用。
 * 只初始化 embedded engine 和 _meta session，不依赖登录状态。
 */
export async function initEngine(): Promise<void> {
  if (_engine) return;

  const db = new Surreal({ engines: { ...createNodeEngines() } });
  await db.connect("surrealkv://./data/app.db");

  // _meta session：专用于读写 last_user_db，与用户数据完全隔离
  const meta = await db.newSession();
  await meta.use({ namespace: "main", database: "_meta" });

  _engine = db;
  _metaSession = meta;
  console.log("[db] engine initialized");
}

/**
 * 步骤 2：登录成功后调用。
 * 切换到用户专属 DB，执行 schema，持久化 tokens，更新 _meta。
 * 并发调用时第二次调用被忽略（_loginInProgress 保护）。
 */
export async function initUserDb(sub: string, tokens: TokenSet): Promise<void> {
  if (_loginInProgress) {
    console.warn("[db] initUserDb already in progress, ignoring concurrent call");
    return;
  }
  _loginInProgress = true;

  try {
    const db = getEngine();
    const dbName = userDbName(sub);

    await db.use({ namespace: "main", database: dbName });
    await loadSchema(db);

    // 持久化 tokens
    await db.query(
      `UPSERT token_store:local CONTENT {
        access_token: $access_token,
        refresh_token: $refresh_token,
        expires_at: $expires_at
      }`,
      {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? null,
        expires_at: new DateTime(new Date(Date.now() + tokens.expires_in * 1000)),
      }
    );

    // 记录 last_user_db 供冷启动恢复
    await getMetaSession().query(
      `UPSERT app_meta:local SET last_user_db = $db`,
      { db: dbName }
    );

    _userDbName = dbName;
    console.log(`[db] user DB initialized: ${dbName}`);
  } finally {
    _loginInProgress = false;
  }
}

export type RestoreResult =
  | { status: "restored"; tokens: TokenSet }
  | { status: "offline" }
  | { status: "unauthenticated" };

/**
 * 步骤 2（替代）：冷启动时调用。
 * 读 _meta → 读 token_store → refresh → connectRemote。
 * 返回结构化结果，restored 时携带新 tokens 供调用方同步内存层。
 */
export async function tryRestoreSession(): Promise<RestoreResult> {
  const meta = getMetaSession();

  // 读取上次登录的 DB 名
  const metaRows = await meta.query<[{ last_user_db?: string }[]]>(
    `SELECT last_user_db FROM app_meta:local`
  );
  const lastUserDb = metaRows[0]?.[0]?.last_user_db;

  if (!lastUserDb) {
    console.log("[db] no previous session found");
    return { status: "unauthenticated" };
  }

  const db = getEngine();
  await db.use({ namespace: "main", database: lastUserDb });
  await loadSchema(db);
  _userDbName = lastUserDb;

  // 读取持久化的 tokens
  const tokenRows = await db.query<[{ access_token: string; refresh_token?: string; expires_at: Date }[]]>(
    `SELECT access_token, refresh_token, expires_at FROM token_store:local`
  );
  const stored = tokenRows[0]?.[0];

  if (!stored?.refresh_token) {
    console.log("[db] no refresh_token in token_store, cannot restore");
    return { status: "offline" };
  }

  try {
    const newTokens = await refreshAccessToken(stored.refresh_token);

    // 写回新 tokens（rotating refresh token 场景下必须更新）
    await db.query(
      `UPSERT token_store:local CONTENT {
        access_token: $access_token,
        refresh_token: $refresh_token,
        expires_at: $expires_at
      }`,
      {
        access_token: newTokens.access_token,
        refresh_token: newTokens.refresh_token ?? null,
        expires_at: new Date(Date.now() + newTokens.expires_in * 1000),
      }
    );

    await connectRemote(newTokens.access_token);
    console.log("[db] session restored");
    return { status: "restored", tokens: newTokens };
  } catch (err) {
    console.warn("[db] token refresh failed, entering offline mode:", err);
    return { status: "offline" };
  }
}

/**
 * 建立 remote SurrealDB 连接。
 * URL 由环境变量 SURREALDB_URL 控制；未设置时静默跳过。
 * 连接失败时静默降级，不影响本地操作。
 */
export async function connectRemote(accessToken: string): Promise<void> {
  const remoteUrl = process.env.SURREALDB_URL || 'wss://cuckoox-06efnpc64psu927c5555v64q5g.aws-usw2.surreal.cloud';

  // 重连时先清理旧引用
  _remoteDb = null;

  try {
    const remote = new Surreal();
    await remote.connect(remoteUrl);
    await remote.use({
      namespace: process.env.SURREALDB_NS ?? "main",
      database: process.env.SURREALDB_DB ?? "docs",
    });
    await remote.authenticate(accessToken);
    _remoteDb = remote;
    console.log(`[db] remote connected: ${remoteUrl}`);
  } catch (err) {
    console.warn("[db] remote connection failed (degraded to local-only):", err);
    _remoteDb = null;
  }
}

/**
 * 登出时调用。
 * 清理 remote 引用、删除 token_store、清空 _meta.last_user_db。
 * remote 只置 null，不调用 close()（避免 surrealdb-node + Bun 的 segfault）。
 */
export async function closeUserDb(): Promise<void> {
  _remoteDb = null;

  if (_userDbName) {
    try {
      const db = getEngine();
      await db.query(`DELETE token_store:local`);
    } catch (err) {
      console.warn("[db] failed to delete token_store on logout:", err);
    }
  }

  try {
    await getMetaSession().query(
      `UPSERT app_meta:local SET last_user_db = NONE`
    );
  } catch (err) {
    console.warn("[db] failed to clear last_user_db on logout:", err);
  }

  _userDbName = null;
  console.log("[db] user session closed");
}

// ─── 访问器 ───────────────────────────────────────────────────────────────────

function getEngine(): Surreal {
  if (!_engine) throw new Error("[db] Engine not initialized — call initEngine() first");
  return _engine;
}

function getMetaSession(): NonNullable<typeof _metaSession> {
  if (!_metaSession) throw new Error("[db] Engine not initialized — call initEngine() first");
  return _metaSession;
}

/** 返回用户专属的 embedded DB 实例。未登录时 throw（query RPC 将错误传回 WebView）。 */
export function getLocalDb(): Surreal {
  if (!_engine) throw new Error("[db] Engine not initialized");
  if (!_userDbName) throw new Error("[db] Not authenticated — call initUserDb() or tryRestoreSession() first");
  return _engine;
}

/** 返回 remote DB 实例，未连接时返回 null。 */
export function getRemoteDb(): Surreal | null {
  return _remoteDb;
}
