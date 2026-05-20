# 后端骨架 PRD（簇 B）

更新时间：2026-05-17

依据：
- [`docs/adr/backend-framework-hono.md`](../../docs/adr/backend-framework-hono.md)
- [`docs/adr/web-only-pivot.md`](../../docs/adr/web-only-pivot.md)
- [`docs/adr/workspace-as-database.md`](../../docs/adr/workspace-as-database.md)

## 一句话

在 `server/` 工作区里把 **Hono on Bun** 拉起来：HTTP + WS、OIDC verify 中间件、内部 hook 鉴权中间件、一条 SurrealDB root 连接到 `_system`、`/health` endpoint、Dockerfile、环境变量约定。**不引入任何业务 endpoint**——簇 C/D 在此骨架上叠加。

## 当前不解决

- workspace 身份模型与 endpoint（簇 C）
- Mastra workflow / 虚拟办公室（簇 D / virtual-office）
- 前端（簇 D2）
- _system schema 的 SurrealQL（簇 C 落地）

## 前置条件

- 簇 A 完成（`server/` workspace 就位）

## 完成定义

- `pnpm --filter @surreal-ck/server dev` 起 Hono on Bun，监听 `0.0.0.0:8080`。
- `GET /health` 返回 `{ status: 'ok' | 'degraded', surrealdb: 'up' | 'down' }`。
- OIDC 中间件 `requireOidc()` 可用：给 Mastra `/api/chat*` 与 Workspace Scope Module 用户入口用。
  - 中间件**只**校验 `iss` / `aud` / `exp` / 签名并提取 `sub` 等基础 claim；**忽略** `https://surrealdb.com/db` / `https://surrealdb.com/ac` scope claim（详见 `backend-framework-hono.md` "OIDC verify 中间件对 token claim 的处理"小节）。
- 内部 hook 鉴权中间件 `requireInternalHook()` 可用：HMAC / bearer 共享密钥校验，给 IdP default-scope hook 等 `/api/internal/*` endpoint 用。
- 一个进程级 SurrealDB root 连接管理器：启动时连 `_system`，断线退避重连；其它代码通过 `getRootConnection()` 拿。
- `Dockerfile` 多阶段构建出单镜像（Bun + 静态资源占位）。
- 环境变量约定写入 `.env.example`。

## 风险

- **OIDC JWKS fetch 缓存**：每个请求都拉 JWKS 会被外部 IdP 限流。中间件必须把 JWKS 缓存 5–10 分钟。
- **root 连接被 SIGTERM 异常关闭**：必须捕获信号、优雅关闭。
- **Dockerfile 镜像大小**：Bun 官方 image 已较小，但要避免把 `node_modules/.cache` 之类带进去。

## Issue 路线图

| # | 名称 | 主体 | 依赖 |
|---|---|---|---|
| 01 | Hono app 骨架 + Bun.serve | server/src/index.ts + 基础中间件链 + /health | wp-restructure 全部 |
| 02 | OIDC verify middleware | requireOidc()，JWKS fetch + cache + jose 校验；shared 内放 `SessionUser` DTO | 01 |
| 03 | SurrealDB root 连接管理器 | server/src/db/root-connection.ts；启动连接 + 断线重连 + getRootConnection() | 01 |
| 04 | /health 接 SurrealDB 探活 | /health 调 root 连接 ping，5s 超时；degraded 状态 | 03 |
| 05 | internal hook 鉴权中间件 | requireInternalHook() HMAC / bearer + IDP_HOOK_SECRET env | 01 |
| 06 | Dockerfile + .env.example + 启动文档 | 多阶段镜像 + 环境变量清单 + README 启动说明 | 04, 05 |

## 验收 KPI

- 本地 `pnpm dev` 0 错误起服务，curl `/health` 200。
- 断开 SurrealDB 后 `/health` 在 ≤5s 内返回 `degraded`；恢复后再 ping 一次回 `ok`。
- `docker build` 成功，镜像 < 200MB。
- 不携带 token curl 任意受保护 endpoint 返回 401。
