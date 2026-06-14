Status: done
Label: ready-for-agent

# WP-D1-07 — Router workflow 使用 per-run caller session

## Parent

`.scratch/mastra-router-migration/PRD.md`

## What to build

让 `/api/chat` 启动 Router workflow 时只创建一条绑定本次 run 的调用者 SurrealDB 会话：后端用前端传入的 OIDC token `connect + authenticate`，把这条 caller session 传给 Mastra storage 和 tools，并在 run 成功、失败、取消或进入 suspended 后关闭连接。

这个 slice 不引入 per-user 常驻连接池，也不允许 root / service session 参与 human workflow 的业务读写。resume 时用当前请求里的最新 token 再创建新的 per-run caller session，续跑结束后同样关闭。

## Acceptance criteria

- [x] 新建 chat run 时，Router workflow、Mastra storage、tool 执行都使用同一条已 authenticate 的 caller session。
- [x] run 成功、失败、取消或 suspended 后，caller session 会被关闭；后台 runner 抛错也必须走 `finally` 清理。
- [x] resume 路径不复用旧 session；它用当前请求 token 建新 caller session，续跑结束后关闭。
- [x] 没有新增 per-user session pool、root 业务写入或 service JWT 兜底。
- [x] 测试覆盖 start/resume 两条路径的 session 创建、传递和关闭，且错误路径不泄漏连接。

## Delivered

- `createAiChatService` 在 start/resume 后台 runner 的 `finally` 中关闭本次 caller session。
- `/api/chat` 在 workflow 服务尚未接管 session 前失败时，立即关闭已 authenticate 的 caller session。
- resume 组装 Mastra run 时继续传入当前调用者 subject，保持 storage 的调用者上下文一致。
- `SurrealMastraStore` 的 storage 查询统一通过注入的 per-run session resolver 执行，避免绕过 caller session。
- 增加 start、resume、suspend、runner error 和 route startup failure 的 session 清理测试。

## Blocked by

None - can start immediately
