---
title: "feat: Local-First 双数据库架构"
type: feat
status: completed
date: 2026-04-25
---

# feat: Local-First 双数据库架构

## Overview

将当前单一 embedded SurrealDB 实例升级为 local-first 双数据库架构：

1. **推迟初始化**：`initEngine()` 在进程启动时执行（只初始化 embedded engine），用户专属 DB 的连接和 schema 推迟到登录后执行
2. **多用户隔离**：每个本地用户对应独立的 `NS main / DB u_<hash>` database，用 JWT `sub` 字段的 hash 命名
3. **token 持久化**：OIDC tokens 存储于用户专属 DB 内的 `token_store` 表，替代内存单例，进程重启后可自动恢复登录
4. **启动恢复**：`NS main / DB _meta` 存储 `last_user_db`，冷启动时读取并还原上次登录的用户上下文
5. **remote 连接**：登录后并行连接 remote SurrealDB（独立 Surreal 实例），使用 `db.authenticate(accessToken)`；失败时静默降级，不影响本地操作

## Problem Frame

当前实现的核心缺陷：

- `initDb()` 在进程启动时立即执行，`db.use()` 硬编码 `NS main / DB docs`，所有用户共享同一 database，无多用户隔离
- OIDC session 仅存在内存（`_session`），进程重启后用户需重新完整 OIDC 授权流程
- `db.authenticate()` 被注释掉（embedded engine 不支持），`$auth` 永远是 `NONE`，行级 PERMISSIONS 形同虚设
- remote SurrealDB 连接逻辑完全未实现

## Requirements Trace

- R1. 进程启动时只初始化 embedded engine，不依赖登录状态
- R2. 每个 OIDC 用户在本地 embedded DB 内拥有独立隔离的 database（`u_<hash>`）
- R3. OIDC tokens 持久化到用户专属 DB 内的 `token_store` 表，进程重启后自动恢复
- R4. `NS main / DB _meta` 存储 `last_user_db`，冷启动时用于定位上次登录用户的 DB
- R5. 冷启动恢复失败（token 过期、网络断开）时，进入只读本地模式（`offlineMode: true`），用户可访问本地已有数据，写操作禁用
- R6. 登录后建立 remote SurrealDB 连接，使用 `db.authenticate(accessToken)`；remote 连接失败静默降级
- R7. 登出后、新用户登录前，`query` RPC 抛出 not-authenticated 错误
- R8. remote 实例登出时只置 null，不调用 close()（与 embedded 保持一致，避免 segfault）
- R9. 登录流程串行执行，防止并发 `db.use()` 导致状态竞争

## Scope Boundaries

- 不实现 local↔remote 数据同步（`pending_sync` 队列）；remote 连接只做认证，sync 是后续迭代
- 不实现 remote schema 自动迁移；remote 的 schema 由服务端管理
- 不处理多窗口 / 多进程场景
- 不修改 WebView / Svelte 侧的 LIVE SELECT 逻辑
- 不修改 `rpc.types.ts` 中的 `AuthState` 接口（只新增 `offlineMode` 字段，向后兼容）

## Context & Research

### 关键技术发现

- **surrealdb@2.0.3 多会话 API**：`Surreal` 类新增 `newSession()` / `forkSession()`，返回 `SurrealSession`，与主连接共享底层 engine 但有独立的 namespace/database/auth 状态。`_meta` DB 和用户专属 DB 可在同一个 embedded `Surreal` 实例上用 session 隔离，无需两个 `Surreal` 实例
- **`db.close()` segfault**：`src/main/db/index.ts:35-39` 注释已记录，Bun 1.3.x + surrealdb-node 3.x 下 `close()` 会 segfault，现有 `closeDb()` 是 no-op。remote 实例同样跳过 close()
- **`authenticate()` 限制**：`src/main/auth/session.ts:24-27` 注释已确认，embedded engine 不支持 `authenticate()`，只有 remote 实例调用
- **`Bun.hash` 返回 bigint**：`Bun.hash(sub)` 返回 `bigint`，需 `.toString(16).padStart(16, "0")` 转为合法 DB 名
- **schema 硬编码 `USE NS main DB docs`**：`schema/main.surql` 第 2 行写死了 `DB docs`，用户专属 DB 执行 schema 前需先 `db.use({ database: "u_<hash>" })`，schema 文件的 `USE` 语句不影响已 use 的会话上下文（`OPTION IMPORT` 模式下 `USE` 语句被忽略——需实现时验证）
- **bun test 兼容性**：NAPI worker thread 导致集成测试不能放在 `bun test` 中，须用 `bun run scripts/test-db.ts`

### 相关文件

- `src/main/db/index.ts` — 当前单例实现，完全重写
- `src/main/auth/session.ts` — OIDCSession 内存单例，重构
- `src/main/auth/oidc.ts` — `refreshAccessToken` 保持不变，直接复用
- `src/main/index.ts` — 主进程入口，修改初始化序列和 RPC handlers
- `schema/main.surql` — 追加 `token_store` 表定义
- `src/shared/rpc.types.ts` — `AuthState` 追加 `offlineMode` 字段

## Key Technical Decisions

- **单一 embedded Surreal 实例 + 多 Session**：`_meta` 用 `newSession()` 建独立会话，用户专属 DB 切换用主实例的 `use()`。避免两个 embedded 实例竞争同一个 KV 文件锁
- **`dbName = "u_" + Bun.hash(sub).toString(16).padStart(16, "0")`**：Bun 内置，无新依赖；固定 16 字符 hex，合法 DB 名；`u_` 前缀防止纯数字开头；wyhash 非加密，仅用于 ID 生成
- **remote 为独立 `new Surreal()`（无 engines 参数）**：走默认 WebSocket engine，与 embedded engine 完全隔离
- **token_store 放用户专属 DB（非 `_meta`）**：`_meta` 只存路由信息（`last_user_db`），敏感数据不混入
- **登出时 remote 只置 null**：与 embedded 保持一致，避免 segfault（R8）
- **`offlineMode: true` 只读降级**：冷启动 token 恢复失败时推送此状态（R5），而非强制跳登录页，保留本地数据可访问性
- **`_loginInProgress` 标志串行化**：`startLogin` 入口检查，进行中则忽略后续请求（R9）

## Open Questions

### Resolved During Planning

- **`schema/main.surql` 的 `USE NS main DB docs` 是否影响用户专属 DB 的 schema 执行**：`OPTION IMPORT` 模式下 schema 文件的 `USE` 声明被忽略，会话已 `use({ database: "u_<hash>" })` 后执行 schema DDL 生效于该 DB。实现时需验证此行为
- **`_meta` DB 是否需要单独的 schema 文件**：`app_meta` 是极简 SCHEMALESS 记录，不需要 schema 文件，直接用代码字符串执行 `UPSERT app_meta:local SET last_user_db = $db`
- **remote 实例 close() 策略**：确认只置 null，不调用 close()（用户已决策，R8）
- **冷启动恢复失败的降级行为**：确认为只读本地模式（用户已决策，R5）
- **query RPC 无 session 时的行为**：确认为抛出 not-authenticated 错误（用户已决策，R7）

### Deferred to Implementation

- **`OPTION IMPORT` 下 `USE` 语句是否真的被忽略**：需在实现 Unit 2 时用真实 embedded engine 验证，若不被忽略则需在执行 schema 前 strip 掉文件头两行或改用代码方式逐条执行 DDL
- **surrealdb@2.0.3 的 `newSession()` 在 embedded engine 下的行为**：是否与主连接共享 KV 文件句柄、是否有独立的 `use()` 状态，需在 Unit 1 实现时验证
- **refresh token rotation**：IDP 是否启用 rotating refresh token（每次刷新后旧 token 失效）影响 `ensureValidSession` 是否必须同步写回 token_store；实现时根据 IDP 实际行为决定

## High-Level Technical Design

> *此图为意图方向说明，供审阅验证思路，不是实现规范。*

```
进程启动
  │
  ▼
initEngine()
  ├─ new Surreal({ engines: createNodeEngines() })
  ├─ connect("surrealkv://<user-data>/data/app.db")
  └─ metaSession = db.newSession()
       └─ metaSession.use({ ns: "main", db: "_meta" })

  │
  ▼
tryRestoreSession()                              [dom-ready 触发]
  ├─ SELECT last_user_db FROM app_meta:local     [via metaSession]
  ├─ [有值] →
  │    db.use({ ns: "main", db: lastUserDb })
  │    执行 schema
  │    SELECT * FROM token_store:local
  │    ├─ [有 refresh_token] →
  │    │    refreshAccessToken()
  │    │    ├─ [成功] → 写回 token_store → connectRemote() → loggedIn: true
  │    │    └─ [失败] → offlineMode: true（只读本地）
  │    └─ [无 token] → loggedIn: false
  └─ [无值] → loggedIn: false

  │
  ▼（用户手动登录）
startOidcLogin() → tokens
  ├─ decode sub → dbName
  ├─ db.use({ ns: "main", db: dbName })
  ├─ 执行 schema
  ├─ UPSERT token_store:local [via main db]
  ├─ UPSERT app_meta:local SET last_user_db [via metaSession]
  ├─ connectRemote(accessToken)
  │    ├─ [成功] → _remoteDb = new Surreal()
  │    └─ [失败] → warn, _remoteDb = null
  └─ 推送 loggedIn: true

  │
  ▼（登出）
closeUserDb()
  ├─ _remoteDb = null（不调 close()）
  ├─ DELETE token_store:local [via main db]
  ├─ UPSERT app_meta:local SET last_user_db = NONE [via metaSession]
  ├─ _session = null
  └─ 推送 loggedIn: false
```

## Implementation Units

- [ ] **Unit 1: 重写 `src/main/db/index.ts`**

**Goal:** 拆分 embedded engine 初始化与用户 DB 初始化，导出新的生命周期 API

**Requirements:** R1, R2, R4, R6, R7, R8, R9

**Dependencies:** 无（先行单元）

**Files:**
- Modify: `src/main/db/index.ts`
- Test: `src/main/db/index.test.ts`

**Approach:**
- 移除 `initDb()`，改为 `initEngine(): Promise<void>`：只做 connect + `metaSession = db.newSession()` + `metaSession.use({ ns: "main", db: "_meta" })`
- 新增 `initUserDb(sub: string, tokens: TokenSet): Promise<void>`：计算 dbName、`db.use()`、执行 schema、写 `token_store`、写 `app_meta`
- 新增 `tryRestoreSession(): Promise<"restored" | "offline" | "unauthenticated">`：读 `_meta` → 读 `token_store` → 调 `refreshAccessToken` → 写回 tokens → `connectRemote`；返回三态结果供调用方决定推送什么 authState
- 新增 `connectRemote(accessToken: string): Promise<void>`：`new Surreal()`（无 engines）、connect remote URL、`authenticate(accessToken)`；失败时 `console.warn` 静默降级
- 新增 `closeUserDb(): Promise<void>`：`_remoteDb = null`、删 `token_store:local`、清 `app_meta.last_user_db`、`_session = null`
- 保留 `getLocalDb(): Surreal`（未 init 时 throw）、新增 `getRemoteDb(): Surreal | null`
- `_loginInProgress` 标志防并发（R9）：`initUserDb` 入口设置，完成后清除

**Patterns to follow:**
- `src/main/db/index.ts` 现有的 `_db` 单例模式
- Mastra init 的静默降级模式（`try/catch + console.warn`，不抛出）

**Test scenarios:**
- Happy path: `initEngine()` 后 `getLocalDb()` 抛出（DB 未指定用户）
- Happy path: `initUserDb(sub, tokens)` 后 `getLocalDb()` 返回已 use 正确 DB 的实例
- Edge case: `initUserDb` 被并发调用两次，第二次调用被忽略（`_loginInProgress` 标志）
- Edge case: 两个不同 sub 产生不同 dbName，调用 `initUserDb` 切换后 `db.use()` 指向新 DB
- Error path: `connectRemote` 连接失败，`getRemoteDb()` 返回 null，`getLocalDb()` 仍可用
- Integration: `tryRestoreSession()` 在 `_meta` 无 `last_user_db` 时返回 `"unauthenticated"`
- Integration: `tryRestoreSession()` 在 `refresh_token` 过期时返回 `"offline"`
- Integration: `tryRestoreSession()` 成功时返回 `"restored"`，token_store 中写入了新 tokens

**Verification:**
- `initEngine()` 后 `metaSession` 可正常读写 `_meta` DB
- `initUserDb` 后 `getLocalDb()` 可执行 schema 中定义的表的 SELECT
- `closeUserDb` 后 `token_store:local` 记录已删除，`app_meta:local.last_user_db` 为 NONE

---

- [ ] **Unit 2: 追加 `token_store` 到 `schema/main.surql`**

**Goal:** 在用户专属 DB 的 schema 中定义 `token_store` 表

**Requirements:** R3

**Dependencies:** 无（可与 Unit 1 并行）

**Files:**
- Modify: `schema/main.surql`

**Approach:**
- 在文件末尾追加 `token_store` 表定义，`PERMISSIONS FULL`（embedded root 访问，`$auth = NONE` 下无意义，设 FULL 语义清晰）
- 字段：`access_token TYPE string`、`refresh_token TYPE option<string>`、`expires_at TYPE datetime`、`updated_at TYPE datetime VALUE time::now()`
- 写入始终使用固定 ID `token_store:local`，用 `UPSERT ... CONTENT {...}` 覆写

**Patterns to follow:**
- `schema/main.surql` 中其他表的 `DEFINE TABLE IF NOT EXISTS` + `DEFINE FIELD IF NOT EXISTS` 格式
- `presence` 表的 `DEFINE INDEX OVERWRITE ... UNIQUE` 处理冲突的模式（`token_store` 单行无需 index）

**Test scenarios:**
- Test expectation: none — 纯 DDL 变更，行为由 Unit 1 的集成测试覆盖

**Verification:**
- `initUserDb` 后能对 `token_store:local` 执行 `UPSERT ... CONTENT` 而不报 schema 错误

---

- [ ] **Unit 3: 重构 `src/main/auth/session.ts`**

**Goal:** 将 session 状态管理从内存迁移到 DB，精简模块职责

**Requirements:** R3, R5

**Dependencies:** Unit 1（依赖 `getLocalDb()`、`closeUserDb()`）

**Files:**
- Modify: `src/main/auth/session.ts`

**Approach:**
- 移除 `_session` 内存变量中的 `tokens` 存储（tokens 已在 `token_store` 持久化）
- `_session` 保留极简形态：只存 `{ expires_at: number }` 用于内存层快速过期检查，避免每次都查 DB
- `loginToSurrealDB(tokens)` 移除 `db` 参数，内部从 `getLocalDb()` 取；写 `token_store` 的逻辑移至 `initUserDb`（Unit 1），此函数只需更新内存 `_session`
- `ensureValidSession()` 移除 `db` 参数；token 刷新成功后必须将新 tokens 写回 `token_store:local`（防止 rotating refresh token 场景下冷启动失败）
- 保留 `clearSession()`、`getSession()`、`getPublicAuthState()`（接口不变）
- `getPublicAuthState()` 增加 `offlineMode?: boolean` 字段（由调用方传入，非此模块内部状态）

**Patterns to follow:**
- 现有 `ensureValidSession` 的刷新判断逻辑（5 分钟窗口）
- `src/main/index.ts` 的 `console.warn` 非致命错误处理

**Test scenarios:**
- Happy path: `ensureValidSession()` 在 token 未过期时直接返回内存 session，不查 DB
- Happy path: `ensureValidSession()` 在 token 将过期时调用 `refreshAccessToken`，刷新后写回 `token_store:local`
- Error path: `refreshAccessToken` 失败时 `_session = null`，返回 null
- Integration: `loginToSurrealDB` 调用后 `getSession()` 返回非 null，`getPublicAuthState()` 返回 `loggedIn: true`

**Verification:**
- token 刷新后 `token_store:local` 中 `refresh_token` 已更新（不是旧值）

---

- [ ] **Unit 4: 修改 `src/main/index.ts`**

**Goal:** 更新主进程入口以匹配新的初始化序列和 session 生命周期

**Requirements:** R1, R5, R7, R9

**Dependencies:** Unit 1、Unit 3

**Files:**
- Modify: `src/main/index.ts`

**Approach:**
- `main()` 中将 `initDb()` 替换为 `initEngine()`；Mastra init 仍在其后，不变
- `dom-ready` 处理：调用 `tryRestoreSession()` 而非 `ensureValidSession(db)`；根据返回值推送对应 authState：
  - `"restored"` → `{ loggedIn: true }`
  - `"offline"` → `{ loggedIn: false, offlineMode: true }`
  - `"unauthenticated"` → `{ loggedIn: false }`
- `startLogin` message handler：
  - 入口检查 `_loginInProgress`，已有进行中则直接返回（R9）
  - 成功路径调用 `initUserDb(sub, tokens)` + 推送 `{ loggedIn: true }`
- `logout` request handler：调用 `closeUserDb()` 替换现有逻辑，移除 `db.invalidate()` 调用（remote 已只置 null）
- `query` request handler：`getLocalDb()` 如果没有已初始化的用户 DB，让 `getLocalDb()` throw，Electrobun RPC 框架将 Error 传回 WebView

**Patterns to follow:**
- 现有 `startLogin` 的 `.then().catch()` 错误传播模式
- Mastra init 的 `try/catch + console.warn` 非致命错误处理

**Test scenarios:**
- Test expectation: none — 主进程入口为集成边界，行为由 Unit 1 集成测试 + 手动 E2E 验证覆盖

**Verification:**
- 冷启动（有历史登录）：应用启动后自动推送 `loggedIn: true`，无需用户操作
- 冷启动（无历史登录）：应用启动后推送 `loggedIn: false`
- 登出后点击 query：WebView 收到错误响应，不返回旧用户数据
- 快速双击登录按钮：只启动一个 OIDC 流程

---

- [ ] **Unit 5: 更新 `src/shared/rpc.types.ts`**

**Goal:** `AuthState` 增加 `offlineMode` 字段，向后兼容

**Requirements:** R5

**Dependencies:** 无（可与其他 Unit 并行）

**Files:**
- Modify: `src/shared/rpc.types.ts`

**Approach:**
- `AuthState` 追加 `offlineMode?: boolean`，可选字段，不破坏现有使用
- 不修改其他类型

**Test scenarios:**
- Test expectation: none — 纯类型变更，TypeScript 编译通过即验证

**Verification:**
- `tsc --noEmit` 无类型错误

## System-Wide Impact

- **`getDb()` 调用方**：现有代码中 `main/index.ts` 直接调用 `getDb()`，已在 Unit 4 中替换为 `getLocalDb()`。搜索 `getDb(` 确认无遗漏
- **schema 文件的 `USE` 语句**：`schema/main.surql` 开头 `USE NS main DB docs` 在用户专属 DB 执行时行为待验证（见 Deferred to Implementation）；若不被 `OPTION IMPORT` 忽略，需在 Unit 1 中 strip 该行
- **`ensureValidSession` 调用方**：现有 `dom-ready` 中调用签名从 `ensureValidSession(db)` 变为无参，Unit 4 中更新
- **WebView 侧 authState 处理**：`offlineMode: true` 是新增字段，WebView 需要处理此状态（显示只读提示），但此修改不在本计划范围内，需单独跟进
- **不变的不变量**：`rpc.types.ts` 的 `AppRPC` 结构不变；`auth/oidc.ts` 不修改；schema 中已有的所有表定义不修改

## Risks & Dependencies

| 风险 | 缓解 |
|------|------|
| `OPTION IMPORT` 下 `USE NS main DB docs` 未被忽略，导致用户专属 DB schema 执行到 `docs` DB | Unit 1 实现时用真实 embedded engine 验证；若不被忽略，在 schema 加载前 strip 头部两行 |
| `newSession()` 在 embedded engine 下未与主实例共享 KV 文件，导致 `_meta` DB 数据写入不同文件 | Unit 1 实现时验证 `metaSession` 读写的数据与主连接在同一 KV 文件中可见 |
| refresh token rotation 场景下 `ensureValidSession` 未写回导致下次冷启动失败 | Unit 3 明确要求刷新成功后必须写回 token_store（见 Unit 3 Approach） |
| `_meta` DB 在首次启动时不存在，`SELECT app_meta:local` 返回 null 而非空记录 | `tryRestoreSession` 中对 SELECT 结果做 null 检查，返回 `"unauthenticated"` |
| 登出时 remote 置 null 后 GC 未及时释放 WebSocket 连接，短时间内重登录时建立重复连接 | `connectRemote` 入口检查 `_remoteDb != null` 时先置 null 再重建 |

## Documentation / Operational Notes

- 环境变量 `SURREALDB_URL` 控制 remote 连接地址；未设置时 remote 连接不建立（纯离线模式）
- embedded DB 文件位于用户数据目录，避免 Electrobun dev 重建 app bundle 时清掉 `./data/app.db`；`_meta` 和所有 `u_<hash>` DB 共存于同一 KV 文件
- `schema/main.surql` 追加 `token_store` 后，现有 embedded DB 文件需重新执行 schema（`IF NOT EXISTS` 保证幂等）

## Sources & References

- Related code: `src/main/db/index.ts`, `src/main/auth/session.ts`, `src/main/index.ts`
- Related code: `schema/main.surql` — `DEFINE ACCESS madocs` 的 JWT 认证逻辑
- External: surrealdb@2.0.3 `SurrealSession` API（`newSession`, `forkSession`, `authenticate`）
