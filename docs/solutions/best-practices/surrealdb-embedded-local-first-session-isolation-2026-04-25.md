---
title: SurrealDB Embedded Local-First 双数据库架构与多用户 Session 隔离
date: "2026-04-25"
category: best-practices
module: db/session
problem_type: best_practice
component: database
severity: high
related_components:
  - authentication
  - tooling
applies_when:
  - 使用 surrealdb-node embedded engine 实现多用户数据隔离
  - 需要在 Bun 运行时中持久化 OIDC token 至本地数据库
  - 设计 local-first 双数据库架构（本地 embedded + 远端 remote）
  - 在 OPTION IMPORT 模式下执行包含 USE 语句的 SurrealQL schema 文件
  - 需要优雅处理 embedded engine 下 db.close() 的 segfault 问题
tags:
  - surrealdb
  - embedded-engine
  - local-first
  - token-persistence
  - oidc
  - bun
  - surrealdb-node
  - multi-user-isolation
---

# SurrealDB Embedded Local-First 双数据库架构与多用户 Session 隔离

## Context

在 Electrobun + Bun + surrealdb-node embedded 桌面应用中，需要同时满足两个相互矛盾的需求：

1. **离线优先**：用户不依赖网络也能完整使用应用，所有业务数据存储在本地文件系统。
2. **云端同步**：用户登录后，数据可与远端 SurrealDB 实例认证，支持跨设备使用。

传统方案（单 embedded 实例 或 只连 remote）无法同时满足这两点。此外，embedded surrealdb-node 存在若干非直觉行为，必须提前了解：

- `OPTION IMPORT` **不**忽略 schema 文件中的 `USE` 语句（已实验验证）
- `newSession()` 与主连接共享底层 KV 文件句柄（已实验验证）
- `db.close()` 在 Bun 1.3.x + surrealdb-node 3.x 下会 segfault

本架构的核心痛点：
- 进程冷启动时无需用户交互即可恢复上次 session
- OIDC token 持久化在本地数据库，重启后自动续期
- remote 连接失败时静默降级为离线只读模式，不阻塞用户操作
- 同一设备的不同用户数据物理隔离在不同 SurrealDB database 下

> 本文档实测结论来自 `scripts/verify-multi-session.ts`，基于 surrealdb@2.0.3 + @surrealdb/node@3.0.3 + Bun 1.3.11。

## Guidance

### 架构总览

```
embedded file (surrealkv://<user-data>/data/app.db)
├── NS main / DB _meta       ← 存储 last_user_db（冷启动恢复用）
└── NS main / DB u_<hash>    ← 用户专属：业务数据 + token_store

remote DB（WebSocket，登录后连接，OIDC authenticate）
```

两个 database 共存于同一个 surrealkv 文件，通过 SurrealDB 的 namespace/database 层做隔离。

---

### 要点 1：用 `newSession()` 隔离 meta DB 与用户 DB

`newSession()` 与主连接共享底层 KV 文件句柄，因此无需第二个 `Surreal` 实例即可操作不同 database：

```typescript
const db = new Surreal({ engines: { ...createNodeEngines() } });
await db.connect(`surrealkv://${dbPath}`);

// meta session：持久存储 last_user_db，与用户数据完全隔离
const metaSession = await db.newSession();
await metaSession.use({ namespace: "main", database: "_meta" });

// 主 session 后续切到用户专属 DB
await db.use({ namespace: "main", database: userDbName(sub) });
```

**注意：** 主 session 调用 `db.use()` 切换 database 是有状态操作，登录流程必须串行化（用 `_loginInProgress` 标志防止并发）。

---

### 要点 2：`OPTION IMPORT` 不忽略 `USE` 语句——必须手动 strip

这是与直觉相悖的关键行为。Surreal Studio 导出的 schema 文件开头通常是：

```surql
OPTION IMPORT;
USE NS main DB docs;
```

在代码中执行此 schema 时，即使主 session 已经切到 `u_<hash>` database，`USE NS main DB docs` **仍然会将 DEFINE TABLE 写入 `docs` database**。

必须在执行 schema 前剥离这两行：

```typescript
function stripSchemaHeader(raw: string): string {
  return raw
    .replace(/^OPTION\s+IMPORT\s*;?\s*/im, "")
    .replace(/^USE\s+NS\s+\S+\s+DB\s+\S+\s*;?\s*/im, "");
}

async function loadSchema(db: Surreal): Promise<void> {
  const raw = await Bun.file("schema/main.surql").text();
  const schema = stripSchemaHeader(raw).replace(/DEFINE BUCKET[^;]*;/gs, "");
  await db.query(schema);
}
```

---

### 要点 3：用户 DB 命名——OIDC `sub` 转合法 DB 名

OIDC `sub` 字段通常含 `|` 等非法字符（如 `auth0|64a3f...`），`Bun.hash()` 返回 `bigint`（非 `number`）：

```typescript
export function userDbName(sub: string): string {
  // bigint → 16 位 hex，加 u_ 前缀防止纯数字开头
  return `u_${Bun.hash(sub).toString(16).padStart(16, "0")}`;
}
// 例：sub="auth0|abc123" → "u_3f8a1c2d4e5b6f70"
```

不能直接用 `Bun.hash(sub).toString()`（十进制数字开头，SurrealDB 命名解析失败）。

---

### 要点 4：token_store 表——持久化 OIDC tokens

在用户专属 DB 的 schema 中定义：

```surql
DEFINE TABLE IF NOT EXISTS token_store SCHEMAFULL
  PERMISSIONS FULL;
DEFINE FIELD IF NOT EXISTS access_token  ON TABLE token_store TYPE string;
DEFINE FIELD IF NOT EXISTS refresh_token ON TABLE token_store TYPE option<string>;
DEFINE FIELD IF NOT EXISTS expires_at    ON TABLE token_store TYPE datetime;
DEFINE FIELD IF NOT EXISTS updated_at    ON TABLE token_store TYPE datetime VALUE time::now();
```

始终使用固定 ID `token_store:local`，用 `UPSERT` 写入：

```typescript
await db.query(
  `UPSERT token_store:local CONTENT {
     access_token: $access_token,
     refresh_token: $refresh_token,
     expires_at: $expires_at
   }`,
  {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? null,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000),
  }
);
```

**关键：** token 刷新成功后必须写回 `token_store:local`，防止 rotating refresh token 场景下下次冷启动失败（IDP 吊销旧 refresh token 后，内存里的旧值导致冷启动必然失败）。

---

### 要点 5：remote 实例与 embedded 实例严格分离

```typescript
// embedded：传 engines 参数
const local = new Surreal({ engines: { ...createNodeEngines() } });

// remote：不传 engines，走默认 WebSocket engine
const remote = new Surreal();
await remote.connect(remoteUrl);
await remote.authenticate(accessToken); // 只在 remote 上调用
```

`db.authenticate()` 在 embedded engine 下不工作（已有注释记录），必须只在 remote 实例上调用。

---

### 要点 6：`db.close()` segfault——登出时只置 null

```typescript
// ✗ 会 segfault
await db.close();

// ✓ 只置 null，依靠 GC 和进程退出清理连接
_remoteDb = null;
```

此问题影响 embedded 和 remote 两类实例（Bun 1.3.x + surrealdb-node 3.x）。

## Why This Matters

不按此方式实现的后果：

| 错误做法 | 后果 |
|---|---|
| 未剥离 schema `USE` 语句 | Schema 写入错误 DB，用户 DB 无表结构，写入时报 field not defined |
| `userDbName` 直接用 `sub` 字符串 | OIDC `sub` 含 `\|` 等非法字符，SurrealDB 拒绝创建 DB |
| `Bun.hash()` 不转 hex | 十进制数字开头，SurrealDB 命名解析失败 |
| 调用 `db.close()` | 进程 segfault，数据可能未落盘 |
| remote 连接失败时抛异常 | 无网络环境下应用完全无法使用，违背 local-first 原则 |
| token 只存内存 | 重启后用户必须重新完整 OIDC 授权流程（打开浏览器），离线场景无法恢复 |
| token 刷新后不写回 DB | IDP rotating refresh token 场景下，下次冷启动用已失效的旧 token，恢复必然失败 |

## When to Apply

以下条件全部满足时适用本架构：

- 运行时为 Bun + surrealdb-node embedded（非独立 SurrealDB 进程）
- 需要在无网络条件下完整运行（local-first）
- 使用 OIDC 认证，token 需持久化并在冷启动时自动恢复
- 同一设备可能有多个用户账号，需数据物理隔离
- 有冷启动后自动恢复上次 session 的需求，避免每次重启都要走完整 OIDC 流程

## Examples

### 示例 1：`stripSchemaHeader`——执行 schema 前剥离 `USE` 指令

```typescript
// ✗ 直接执行：USE NS main DB docs 会把表定义写入 docs DB
await db.query(rawSchema);

// ✓ 先剥离头部再执行
function stripSchemaHeader(raw: string): string {
  return raw
    .replace(/^OPTION\s+IMPORT\s*;?\s*/im, "")
    .replace(/^USE\s+NS\s+\S+\s+DB\s+\S+\s*;?\s*/im, "");
}
await db.query(stripSchemaHeader(rawSchema));
```

### 示例 2：`userDbName`——将 OIDC `sub` 转换为合法 DB 名

```typescript
// ✗ 直接用 sub — 含非法字符
await db.use({ database: sub });

// ✗ Bun.hash 不转 hex — 十进制数字开头
const bad = `u_${Bun.hash(sub)}`; // "u_3348085702347088390"（n 结尾，bigint）

// ✓ 正确转换
export function userDbName(sub: string): string {
  return `u_${Bun.hash(sub).toString(16).padStart(16, "0")}`;
}
await db.use({ namespace: "main", database: userDbName(sub) });
```

### 示例 3：`tryRestoreSession`——三态返回，冷启动恢复

```typescript
type RestoreResult =
  | { status: "restored"; tokens: TokenSet }
  | { status: "offline" }       // token 恢复失败，进入只读本地模式
  | { status: "unauthenticated" }; // 无历史登录记录

async function tryRestoreSession(): Promise<RestoreResult> {
  // 1. 读 _meta DB 中记录的 last_user_db
  const [metaRows] = await metaSession.query<[{ last_user_db?: string }[]]>(
    "SELECT last_user_db FROM app_meta:local"
  );
  if (!metaRows?.[0]?.last_user_db) return { status: "unauthenticated" };

  // 2. 切到用户 DB，执行 schema（幂等），读取 token
  await db.use({ namespace: "main", database: metaRows[0].last_user_db });
  await loadSchema(db);
  const [tokenRows] = await db.query<[{ refresh_token?: string }[]]>(
    "SELECT refresh_token FROM token_store:local"
  );
  if (!tokenRows?.[0]?.refresh_token) return { status: "offline" };

  try {
    const newTokens = await refreshAccessToken(tokenRows[0].refresh_token);
    // 3. 写回新 tokens（rotating refresh token 必须更新）
    await db.query(`UPSERT token_store:local CONTENT {...}`, newTokens);
    await connectRemote(newTokens.access_token); // 失败时静默降级
    return { status: "restored", tokens: newTokens };
  } catch {
    return { status: "offline" }; // 网络问题，非登出
  }
}

// 调用方使用三态结果
const result = await tryRestoreSession();
if (result.status === "restored") {
  loginToSurrealDB(result.tokens); // 同步内存层
}
const state =
  result.status === "offline"
    ? { loggedIn: false, offlineMode: true }
    : getPublicAuthState();
```

### 示例 4：`connectRemote`——静默降级

```typescript
async function connectRemote(accessToken: string): Promise<void> {
  const remoteUrl = process.env.SURREALDB_URL;
  if (!remoteUrl) return; // 未配置则跳过，不报错

  _remoteDb = null; // 清理旧引用，防重复连接
  try {
    const remote = new Surreal(); // 无 engines 参数
    await remote.connect(remoteUrl);
    await remote.use({ namespace: "main", database: "docs" });
    await remote.authenticate(accessToken);
    _remoteDb = remote;
  } catch (err) {
    console.warn("[db] remote connect failed, local-only mode:", err);
    _remoteDb = null; // 不抛出
  }
}
```

## Related

- `docs/plans/2026-04-25-002-feat-local-first-dual-db-architecture-plan.md` — 架构规划文档，包含需求溯源和技术决策
- `src/main/db/index.ts` — 本架构的完整实现
- `scripts/verify-multi-session.ts` — 验证 newSession() KV 共享 + OPTION IMPORT USE 行为的实验脚本
