Status: needs-triage
Label: needs-triage

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
  db = new Surreal();
  await db.connect(import.meta.env.VITE_SURREAL_URL);
  await db.signin({
    ac: token.role === 'admin' ? 'admin' : 'participant',
    ns: 'main',
    db: token.current_db,
    token: token.raw,
  });
  await db.use({ ns: 'main', db: token.current_db });
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
  currentWorkspace = { ... };           // 由 token claim 填
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

- [ ] 登录后 `currentWorkspace != null` 且 `getSurreal()` 返回的 Surreal 已连接到正确 db。
- [ ] 浏览器 console `await getSurreal().select('user')` 能拿到 user 表数据。
- [ ] 浏览器 console `await getSurreal().live('office_message')` 拿到一个 live id；其它 tab 写消息能触发回调。
- [ ] 切换 workspace 后旧 db 连接被 close，新 db 连接建立；getSurreal() 始终指向最新。
- [ ] 中途断网 → workspace-store.connectionState 变 'closed'；恢复后自动 'open'。

## Blocked by

- `.scratch/web-frontend-migration/issues/02-oidc-login-shell.md`

## Notes

- 用官方 `surrealdb` npm 包；不引入 `surrealdb-js` 等已废弃别名。
- Vite dev 时 `VITE_SURREAL_URL` 指 `ws://localhost:8000/rpc`；prod 指 `wss://db.example.com/rpc`。
- 不在本 issue 实现 retry 退避策略——MVP 简单重连即可；后续若发现 reconnect 风暴单独立 issue。
- `connectSurreal` 在切 workspace 时**先 close 旧的再连新的**——避免两条连接同时 LIVE 订阅产生重复事件。
