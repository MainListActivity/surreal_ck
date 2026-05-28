Status: done
Label: done

# WP-D2-03 — SurrealDB 直连客户端（浏览器）

## Parent

`.scratch/web-frontend-migration/PRD.md`

## What to build

```
web/src/lib/surreal.ts            -- 单例 Surreal 实例，按 IdP token 自动 signin
web/src/lib/workspace-store.ts    -- $state runes：当前 db 连接 + 当前 user + last-known token
```

### `lib/surreal.ts`

```ts
import { Surreal } from 'surrealdb';

let db: Surreal | null = null;

export async function connectSurreal(token: OidcToken): Promise<Surreal> {
  if (db) { await db.close(); }
  const dbName = token.claims['https://surrealdb.com/db'];
  const access = token.claims['https://surrealdb.com/ac'];
  db = new Surreal();
  await db.connect(import.meta.env.VITE_SURREAL_URL);
  await db.signin({
    ac: access,
    ns: 'main',
    db: dbName,
    token: token.raw,
  });
  await db.use({ ns: 'main', db: dbName });
  return db;
}

export function getSurreal(): Surreal {
  if (!db) throw new Error('Surreal not connected');
  return db;
}

export async function closeSurreal(): Promise<void> {
  await db?.close();
  db = null;
}
```

### `lib/workspace-store.ts`

```ts
export const currentWorkspace = $state<{
  slug: string;
  name: string;
  dbName: string;
  role: 'admin' | 'participant';
} | null>(null);

export const currentUser = $state<SessionUser | null>(null);

export async function enterWorkspace(token: OidcToken) {
  currentWorkspace = { ... };           // 由 token scope + /api/session/workspaces 填
  currentUser = { ... };                // 由 token claim 填
  await connectSurreal(token);
}
```

### 集成点

- 登录回调（issue 02）拿到 token 后调 `enterWorkspace(token)`。
- 切换 workspace（issue 05）拿到新 token 后调 `enterWorkspace(newToken)`。
- 任何业务组件需要查 SurrealDB → `import { getSurreal } from '$lib/surreal'`。

### 错误处理

- SurrealDB 断线 → workspace-store 暴露 `connectionState: 'open' | 'closing' | 'closed'`；前端组件渲染 toast；自动指数退避重连。
- token 过期 → SurrealDB 抛 SignInError → 触发 IdP silent refresh → 新 token → 重新 signin。

## Acceptance criteria

- [x] 登录后 `currentWorkspace != null` 且 `getSurreal()` 返回的 Surreal 已连接到正确 db。_（`enterWorkspace` 从 claims 派生 workspace + connect；单测覆盖）_
- [~] 浏览器 console `await getSurreal().select('user')` 能拿到 user 表数据。_（代码路径已落，未现场连真实 SurrealDB 跑）_
- [~] 浏览器 console `await getSurreal().live('office_message')` 拿到一个 live id；其它 tab 写消息能触发回调。_（同上，留待联调）_
- [x] 切换 workspace 后旧 db 连接被 close，新 db 连接建立；getSurreal() 始终指向最新。_（"先 close 旧再连新" 有单测断言顺序）_
- [x] 中途断网 → workspace-store.connectionState 变 'closed'；恢复后自动 'open'。_（subscribe connected/reconnecting/disconnected → connectionState；单测覆盖）_

## Blocked by

- `.scratch/web-frontend-migration/issues/02-oidc-login-shell.md`

## Notes

- 用官方 `surrealdb` npm 包；不引入 `surrealdb-js` 等已废弃别名。
- Vite dev 时 `VITE_SURREAL_URL` 指 `ws://localhost:8000/rpc`；prod 指 `wss://db.example.com/rpc`。
- 不在本 issue 实现 retry 退避策略——MVP 简单重连即可；后续若发现 reconnect 风暴单独立 issue。
- `connectSurreal` 在切 workspace 时**先 close 旧的再连新的**——避免两条连接同时 LIVE 订阅产生重复事件。

## 落地记录（2026-05-29，TDD）

surrealdb 包是 **2.0.3**，API 与 issue 里的伪代码不同，按实际签名落地：

- `signin({ac,ns,db,token})` 在 2.0.3 不存在。改用 `connect(url, { namespace, database, authentication: rawToken })`——`authentication` 接受裸 JWT（`Token` 类型），由 driver 持有并在 session 过期时复用；JWT 里的 access claim 决定 access（admin/participant）。
- 连接状态走 `db.status`（`disconnected|connecting|reconnecting|connected`）+ `db.subscribe('connected'|'reconnecting'|'disconnected', …)`，不是事件名硬编码。

文件：

- 新增 `web/src/lib/surreal.ts`：`createSurrealClient({ factory? })` 工厂（注入 `SurrealConn` 便于单测）+ 模块级单例导出 `connectSurreal()` / `getSurreal()` / `closeSurreal()`。`SurrealConn` 是对官方 driver 的窄接口切片（connect/use/close/status/subscribe），生产用 `new Surreal()`。切 workspace 先 `close` 旧连接再 `connect` 新连接。
- 新增 `web/src/lib/workspace-store.ts`：**逻辑层**（无 runes，纯 bun test 可测）。`createWorkspaceState({ surrealUrl, namespace, connect, onChange? })` → `enterWorkspace({ rawToken, claims })` 从 claims 派生 `currentUser`/`currentWorkspace`（`name`/`slug` 留给 issue 05 的 Workspace Scope Module 填，token 只给 `dbName`+`role`）并连库；订阅连接事件维护 `connectionState`（open/closing/closed）；`onChange` 推快照给响应式层。
- 新增 `web/src/lib/workspace-store.svelte.ts`：**runes 镜像**。用 `$state` 包逻辑层，绑定默认 surreal client + `import.meta.env.VITE_SURREAL_URL`，`onChange` 回填 `$state` 供组件订阅。
- 更新 `web/src/env.d.ts`：声明 `VITE_SURREAL_URL`。

TDD：

- `web/src/lib/surreal.test.ts`：连接到正确 ns/db + getSurreal 返回同实例、切 workspace 先 close 旧再连新、未连接 / close 后 getSurreal 抛错。
- `web/src/lib/workspace-store.test.ts`：从 claims 派生 user/workspace 并连库、断线→closed / 重连→open、`onChange` 推送快照序列。

验收命令：

- `pnpm --filter @surreal-ck/web test`：21 pass / 0 fail（含本 issue 新增 6 例）。
- `pnpm --filter @surreal-ck/web typecheck`：tsc + svelte-check 0 error / 0 warning。
- `pnpm --filter @surreal-ck/web build`：Vite build 成功。
- `pnpm -r run typecheck`：shared / server / web 全绿。
- `pnpm -r --if-present run test`：shared 18 + web 21 + server 116 全绿。

留待联调（需真实 SurrealDB）：`select('user')` / `live('office_message')` 现场验证；指数退避重连按 Notes 不在本 issue 做。
