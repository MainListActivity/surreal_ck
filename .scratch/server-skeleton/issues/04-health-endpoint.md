Status: done
Label: done

# WP-B-04 — /health 接 SurrealDB 探活

## Parent

`.scratch/server-skeleton/PRD.md`

## What to build

`/health` 升级为：

```ts
GET /health → 200 {
  status: 'ok' | 'degraded',
  surrealdb: 'up' | 'down',
  uptimeSec: number,
}
```

实现：

- `surrealdb`：调 `isRootConnected()` + 一次 `SELECT 1` 5s 超时；任一失败 → `'down'`。
- `status`：所有依赖都 `up` → `'ok'`；否则 `'degraded'`。
- 返回码始终 200（让 K8s liveness 简单 +便于 LB 不下线整个容器），由 K8s readinessProbe 用 status 字段决定流量进出。

## Acceptance criteria

- [x] SurrealDB 在线时 `{ status: 'ok', surrealdb: 'up', ... }`。
- [x] SurrealDB 不可达时 `{ status: 'degraded', surrealdb: 'down', ... }`，HTTP 仍 200。
- [x] 响应延迟 < 100ms（SurrealDB 在线时）。
- [x] /health endpoint 无需 OIDC，任何调用方可访问。

## Notes

- 不要在 /health 做"重连尝试" —— 重连由 root-connection 管理器自己做；本 endpoint 只读状态。
- 若未来 dispatcher 是 launch-critical，可在 health 里增加 `dispatcher: 'running' | 'stopped'` 字段（簇 virtual-office 04 增量加）。
