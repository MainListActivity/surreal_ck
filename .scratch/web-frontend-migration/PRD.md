# 前端迁移 PRD（簇 D2）

更新时间：2026-05-17

依据：
- [`docs/adr/web-only-pivot.md`](../../docs/adr/web-only-pivot.md)
- [`docs/adr/workspace-as-database.md`](../../docs/adr/workspace-as-database.md)

## 一句话

把 `web/legacy/`（即原 `src/renderer/`）的 Svelte 5 + RevoGrid 前端迁到 `web/`，构建工具改为标准 Vite 8；用 oidc-client-ts 做 SPA OIDC；用 `surrealdb` 浏览器 SDK 直连 SurrealDB 做业务读 / 写 / LIVE；workspace 列表 / 切换 / 创建走 Bun server 的 Workspace Scope Module；AI 抽屉接 Bun server `/api/chat` + `/api/chat/stream`。**不引入新 UI 功能**。

## 当前不解决

- 办公室 / 通知 UI（virtual-office issue 09 / 10）
- 表单 / 仪表盘 / 表格新交互
- 主题 / 移动端适配
- 移动端推送

## 前置条件

- 簇 A / B / C / D1 完成

## 完成定义

- `pnpm --filter @surreal-ck/web dev` 起 Vite dev server，访问 `localhost:5173` 能：
  - 走 OIDC 登录（浏览器内 SPA Auth Code + PKCE，重定向到 IdP → 回调拿 token，**不经过后端**）
  - 从 IdP token claim 拿到 `https://surrealdb.com/db` + `https://surrealdb.com/ac`
  - 用 `surrealdb` 浏览器 SDK `db.signin({ ac, ns, db, token })` 直连 SurrealDB
  - 进入某 workspace 看到工作簿主界面（RevoGrid 表格直接从 SurrealDB SELECT / LIVE）
  - 切换 workspace：调用 `/api/session/switch-workspace` → IdP scope 更新 → silent refresh → 重新 signin
  - 管理员可点"新建 workspace" → 调 `/api/workspaces` → 后端创建 db + 切 scope → silent refresh 进入新 workspace
  - 打开 AI 抽屉，发消息，看到 Router workflow 流式响应（调后端 /api/chat）
- `web/legacy/` 被删空。

## 风险

- **vite.config.ts 重写**：原配置面向 Electrobun 的 views:// 协议，需要换成标准 Vite 8 web 配置。
- **OIDC 登录壳**：MVP 直接用 `oidc-client-ts` 或类似 SPA OIDC 库；token 放 sessionStorage（接受 XSS 风险，必须配 CSP + sanitize + 第三方脚本约束）。
- **Hono RPC 客户端**：可以用 `hono/client` 拿到端到端类型推导；shared/router-workflow.types 要与 server endpoint 对齐。
- **WebSocket 客户端**：浏览器原生 WebSocket + 简单封装；不引入 socket.io。
- **RevoGrid 配置**：当前 RevoGrid 在 Electrobun WebView 里跑得好，浏览器里基本一致；要确认 worker / 静态资源路径正确。

## Issue 路线图

| # | 名称 | 主体 | 依赖 |
|---|---|---|---|
| 01 | Vite 8 + Svelte 5 web 构建链 | 重写 web/vite.config.ts、web/index.html、web/src/main.ts | wp-restructure |
| 02 | OIDC 登录壳（SPA，不经过后端） | oidc-client-ts + PKCE + token / claim 管理 + silent refresh | 01 |
| 03 | SurrealDB 直连客户端 | web/src/lib/surreal.ts：按 token 的 surreal db/ac claims 调 db.signin；workspace-store 暴露当前 db 连接 | 02 |
| 04 | API client（Hono RPC） | web/src/lib/api.ts，对接 Workspace Scope Module + /api/chat | 01 |
| 05 | Workspace 切换器 | 顶栏 dropdown 调 `/api/session/workspaces`；切换调 `/api/session/switch-workspace` + silent refresh + 重新 signin | 02, 03, 04 |
| 06 | 新建 workspace 流程 | 调 `/api/workspaces` → 后端建库和切 scope → 前端 silent refresh 进入新 workspace | 04, 05, C-06 |
| 07 | Workbook 主界面迁入 | web/legacy/ 内 Svelte UI 搬到 web/src/，所有 Electrobun RPC 替换为 surrealdb-js 直连 SELECT / LIVE / INSERT | 03 |
| 08 | AI 抽屉接 chat/stream | 抽屉 UI 调 /api/chat + 连 /api/chat/stream WS + 渲染 progress/chunk/suspend | 04, D1-04, D1-05 |
| 09 | 删 web/legacy | 删除原 src/renderer 残留 | 01-08 |

## 验收 KPI

- 全新浏览器无痕窗口：登录 → 选 workspace → 看到表格 → 在 AI 抽屉问"打开工作簿 X" → 流式得到响应 → 全程无 console error。
- 切换 workspace 时旧 surreal token 被丢弃，新 token 生效。
- 关闭标签页再打开（OIDC token 还在 sessionStorage 但已过期）→ 自动重定向 OIDC 重登。
- `web/legacy/` 不存在。
