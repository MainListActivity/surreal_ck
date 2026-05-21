Status: done
Label: done

# WP-B-03 — SurrealDB root 连接管理器

## Parent

`.scratch/server-skeleton/PRD.md`

## What to build

```
server/src/db/
  root-connection.ts   -- 进程级单例
```

API：

```ts
export async function initRootConnection(): Promise<void>;   // 启动时调
export function getRootConnection(): Surreal;                // 业务代码用
export async function closeRootConnection(): Promise<void>;  // 退出时调
export function isRootConnected(): boolean;                  // /health 用
```

行为：

- 用 `SURREAL_URL` / `SURREAL_NS=main` / `SURREAL_ROOT_USER` / `SURREAL_ROOT_PASS` 连接。
- 启动时 `SIGNIN { user, pass }` + `USE NS main DB _system`。
- 监听 disconnect 事件 → 退避重连（1s / 2s / 5s / 10s 上限循环）。
- 进程 `SIGTERM` / `SIGINT` 信号 → 调 `closeRootConnection()`。

env 新增：

- `SURREAL_URL`（如 `ws://surrealdb:8000/rpc`）
- `SURREAL_ROOT_USER` / `SURREAL_ROOT_PASS`

`server/src/index.ts` 启动序列：

```ts
await initRootConnection();
const server = Bun.serve({ ... });
process.on('SIGTERM', async () => { server.stop(); await closeRootConnection(); });
```

## Acceptance criteria

- [x] 启动时 SurrealDB 可达 → `isRootConnected() === true`。
- [x] SurrealDB 不可达 → 启动**不**直接 exit，而是 `isRootConnected() === false` + 持续退避重连；日志每次重连尝试都记录。
- [x] SurrealDB 中途断开 → `isRootConnected()` 切 false；恢复后回 true，无需重启。
- [x] SIGTERM 时优雅关闭，不出未捕获 Promise rejection。
- [x] 根连接 SIGNIN 凭据**不**写入日志（即使在 DEBUG 级别）。

## Notes

- 进程内仅一条 root 连接；其它 SIGNIN 会话（用户 token / employee secret）由各自代码持有，互不混用。
- 重连退避不必无限——10s 上限循环够；外部监控负责"超 N 次失败时告警"，本 issue 不实现告警。
- 写 _system 的并发由 SurrealDB 自身事务保证；本管理器不在应用层加锁。
