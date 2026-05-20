# ADR: 后端 HTTP / WS 框架选 Hono

- **Status**: Accepted
- **Date**: 2026-05-17
- **Scope**: `server/` 顶层工程；所有 HTTP endpoint、WS endpoint、中间件
- **Companions**:
  - [`web-only-pivot.md`](./web-only-pivot.md)（部署形态）
  - [`workspace-as-database.md`](./workspace-as-database.md)（身份模型）
  - [`virtual-office.md`](./virtual-office.md)（业务能力）
  - [`frontend-direct-connect.md`](./frontend-direct-connect.md)（前端直连 SurrealDB 后，后端职责急剧瘦身）

> **2026-05-17 update**：随 [`frontend-direct-connect.md`](./frontend-direct-connect.md) 接受，后端职责急剧瘦身——业务数据 CRUD / LIVE 转发代理 endpoint 整体废除。Hono 仍然适合，但后端仍保留 Workspace Scope Module：workspace 列表、切换、创建、IdP default-scope hook。这些 endpoint 只管理 token scope 和 workspace lifecycle，不代理工作簿 / 数据表 / 办公室业务数据。

## Context

[`web-only-pivot.md`](./web-only-pivot.md) 确定后端是"单容器 Bun server"，但没指定用什么框架来写 HTTP / WS。本 ADR 选定该框架。

候选必须满足的硬约束：

1. **运行时是 Bun**——本仓库已经在 Bun 上跑 Mastra workflow + surrealdb.js（CLAUDE.md 技术栈节）。
2. **WebSocket 支持良好**——Mastra workflow 的流式进度推送（`POST /api/chat` + `WS /api/chat/stream`）需要 WS upgrade。注意：自从 [`frontend-direct-connect.md`](./frontend-direct-connect.md) 接受后，后端**不再做 SurrealDB LIVE 转发**——浏览器直接订阅 SurrealDB LIVE；WS 在后端仅用于 Mastra workflow 流式输出。
3. **不引入 ORM**——schema/PERMISSIONS/access 都在 SurrealQL 里，TS 层只走 `surrealdb.js`。
4. **支持长期常驻进程状态**——dispatcher、employee_credential 缓存。排除 serverless / edge runtime。
5. **OIDC verify 简单**——用于 `/api/chat` 与 Workspace Scope Module 的用户入口；能直接挂 JWKS URL 校验。
6. **代码量 MVP 必须小**——一个人维护。

软偏好：TS 类型推导友好；文档清晰、活跃维护；不锁定到某厂云。

## Decision

**选 Hono**（`hono@^4` 以上）。

理由：

- **Bun 上的事实标准**——Mastra Cloud、SurrealDB Bun 教程、多数 Bun 模板都默认 Hono；社区案例最多。
- **WS 一等支持**——`hono/ws` 直接给 `app.get('/path', upgradeWebSocket(...))`，与 HTTP 路由统一。
- **中间件链精简**：OIDC verify 可以用 `hono/jwt` + 自定义 JWKS fetcher（或 jose）；CORS / 错误处理 / 日志都有官方 middleware。
- **TS 类型友好**：`Context<{ Variables: { user: ... } }>` 把中间件注入的状态类型推到 handler。
- **不锁运行时**：Hono 同时跑 Bun / Node / Cloudflare Workers / Deno；未来若需要把无状态部分（HTTP-only）抽出来跑在别的运行时，无需大改。
- **包足够小**：核心 < 50KB，对单容器镜像友好。

## Boundaries

本 ADR 明确**只**选 HTTP / WS 框架，不选：

- 状态管理 / RPC 协议（不用 tRPC——见 Alternatives）
- ORM / query builder（继续直用 `surrealdb.js`）
- 日志库（用 `pino` 或 Hono 内建 logger 都行，下放到 issue 阶段）
- 验证库（用 `zod` 与 `@hono/zod-validator`——下放到 issue 阶段）
- 任务调度 / cron 引擎（dispatcher 用 `setInterval`，参见 [`virtual-office.md`](./virtual-office.md) §3）

## Minimal Dependencies

下面是本仓库后端引入的全部 Hono 相关依赖，issue 阶段以此为锚：

```jsonc
{
  "hono": "^4",
  "@hono/zod-validator": "^0.x",
  "zod": "^3",          // 已是仓库现有依赖
  "jose": "^5"          // OIDC JWKS verify；不依赖 hono/jwt 的硬编码 key 流派
}
```

不必要引入 `@hono/node-server`（Bun 内置 `Bun.serve` 直接搭 Hono），也不引入任何 Hono CLI / 脚手架。

## Alternatives Considered

### A. Elysia

不选。Elysia 在 Bun 上类型推导业界最强、性能 benchmark 第一，但：

- 生态比 Hono 小（中间件、教程、AI 协作样例少）。
- 强绑 Bun，**未来若需要把后端无状态部分（如 sessions endpoint）抽到 Node 容器或边缘**，迁移成本高。
- 与 Mastra 文档/示例的衔接不如 Hono 顺畅。

如果未来"类型完美推导"成为强需求（如复杂 GraphQL-like 接口），可单点迁出。

### B. Bun.serve 裸跑

不选。零依赖在 MVP 头两周看似优雅，但很快需要自己造路由、中间件链、WS upgrade 处理、错误归一——本质上是在小范围重写 Hono。

### C. Express / Fastify

不选。Node 生态经典，但在 Bun 上跑等于绕路；且与 Bun 的 fast path（`Bun.serve`、内置 WS）有摩擦。

### D. NestJS / AdonisJS

不选。Full-stack / 装饰器风 / 强约定与"Mastra agents + Office dispatcher 是核心、HTTP 只是表层"的本仓库定位错配；重型框架在一人维护场景下心智成本太高。

### E. tRPC

不选。它是 RPC 协议而非 HTTP 框架，需要附在 HTTP 框架上用。本仓库需要原生 WS 流式输出 + 标准 HTTP endpoint（部分路径需要 curl 调试），单 tRPC 表达力不够。后续若想加 tRPC 做"管理面板内部接口"可以叠在 Hono 上（`@trpc/server` 适配 Hono），与本 ADR 不冲突。

## Consequences

### 正面

- 后端入口代码极短：`new Hono().use(...).route(...).fire()`。
- WS 流式输出与 HTTP endpoint 在同一路由表，心智一致。
- Mastra 示例与 Bun 社区资源最多，AI 协作友好。
- 未来若要把无状态 endpoint 抽到边缘运行时，Hono 直接迁移。

### 负面

- 类型推导不如 Elysia 极致——可接受，仓库类型主要靠手写 zod schema + 仓库内 DTO，不依赖框架自动推。
- 选 Hono 等于默认"OIDC verify 自己写中间件"——`jose` + JWKS fetch + 缓存 5 分钟即可，约 50 行；issue 阶段会落地一个 `requireOidc()` middleware。

## Endpoint inventory（MVP 后端 endpoint 全集）

收到 [`frontend-direct-connect.md`](./frontend-direct-connect.md) 影响后，MVP 后端 endpoint 列表如下：

| Path | 用途 |
|---|---|
| `GET  /health` | 健康检查（K8s liveness） |
| `GET  /api/session/workspaces` | Workspace Scope Module：列出当前 subject 可进入的 workspace。 |
| `POST /api/session/switch-workspace` | Workspace Scope Module：验证 membership，更新最近选择，调用 IdP scope adapter。 |
| `POST /api/workspaces` | Workspace Scope Module：root 创建 workspace database、应用模板、写 owner 和 `_system` 索引。 |
| `POST /api/workspaces/:slug/members` | Workspace Scope Module：邀请 / 添加成员；原子同写 ws db `user` + `_system.user_workspace_index`。 |
| `PATCH /api/workspaces/:slug/members/:userId` | Workspace Scope Module：成员 role 变更（admin / participant）。 |
| `DELETE /api/workspaces/:slug/members/:userId` | Workspace Scope Module：写 `disabled_at` 软移除。 |
| `POST /api/workspaces/:slug/employees` | Workspace Scope Module（员工 lifecycle）：管理员创建虚拟员工，root 写 `employee_credential` + dispatcher 缓存刷新。 |
| `POST /api/workspaces/:slug/employees/:id/retire` | Workspace Scope Module（员工 lifecycle）：退休员工，清 dispatcher 缓存与员工 secret。 |
| `POST /api/chat` | Mastra Router workflow 入口（流式回写） |
| `WS   /api/chat/stream` | Mastra workflow 流式 progress / chunk / suspend / done |
| `POST /api/chat/runs/:runId/resume` | suspend 决策后恢复 |
| `GET  /api/internal/idp/default-scope` | IdP 登录 hook：按本应用 `_system.user_workspace_index` 返回默认 db/ac scope。 |

`/api/internal/*` 必须验证调用源（IdP 共享密钥、mTLS 或专用 bearer token），与外部 endpoint 隔离。**没有**工作簿 / 数据表 / office_* LIVE 转发等业务代理 endpoint；这些都由前端直连 SurrealDB 完成。

### OIDC verify 中间件对 token claim 的处理

后端 `requireOidc()` 中间件**只**验证 token 签名 + `iss` + `aud` + `exp`，并提取 `sub` / `email` 等基础 claim。**不约束** `https://surrealdb.com/db` / `https://surrealdb.com/ac` 这两个 scope claim——它们只是给 SurrealDB AUTHENTICATE 用的，对后端 endpoint 无意义。

- `POST /api/session/switch-workspace`、`GET /api/session/workspaces`、成员管理、员工 lifecycle 等 Workspace Scope Module endpoint **必须忽略** scope claim：否则用户被当前 token 的 db scope 卡住，无法切换或操作其它 workspace。
- `POST /api/chat`：同样只信 `sub`；Mastra tool 内部用调用者 OIDC token `db.signin` 到 token scope 所指 db，是 Mastra 而非中间件的责任。

## Open Questions

1. **HTTP 错误归一格式**：与前端约定 `{ error: { code, message } }` 还是 Hono 默认 problem+json？下放到 server-skeleton issue 阶段。
2. **CORS 策略**：前端域与后端域分离（前端 app.example.com，后端 api.example.com，SurrealDB db.example.com）则必须配 CORS 白名单。issue 阶段定。
3. **IdP default-scope hook 鉴权**：IdP 已选定 `o.maplayer.top/t/ck`（见 [`../oidc.md`](../oidc.md)）；hook 鉴权方式（共享密钥 / 专用 bearer token）待簇 C issue 03 按 IdP 实际能力回填。
4. **WS 流式 RunBus**：MVP 一 runId 一连接即可；多 tab 多端同时订阅同 run 的需求超 MVP 范围。
