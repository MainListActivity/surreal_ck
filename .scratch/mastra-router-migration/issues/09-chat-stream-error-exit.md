Status: done
Label: done

# WP-D1-09 — stream 不再只剩 ping，失败可回传到前端

## Parent

`.scratch/mastra-router-migration/PRD.md`

## What to build

把 Router workflow 启动、storage 持久化、LLM 调用、tool 执行中的失败统一翻译为 `/api/chat/stream` 的 `error` 事件，并让前端 AI 抽屉在收到错误时退出“路由中...”状态。心跳 `ping` 只表示 WS 存活，不能掩盖后台 workflow 已失败或卡在启动阶段。

这个 slice 要覆盖 dev 环境 `/api/chat/stream` 的 WebSocket 代理路径，确保前端通过 Vite 访问 `/api/chat/stream` 时实际升级到 Bun 后端。

## Acceptance criteria

- [x] 后台 runner 在 workflow 启动、storage、LLM、tool 任一阶段抛错时，RunBus 缓存并推送 `kind: "error"` 事件。
- [x] 前端 AI 抽屉收到 `error` 后停止 loading/“路由中...”状态，并展示可理解的错误信息。
- [x] WebSocket 连接只有 `ping` 且超过合理等待时间时，前端有超时退出策略，不会无限卡住。
- [x] Vite dev server 的 `/api` 代理支持 `/api/chat/stream` WebSocket upgrade，开发环境和生产路由行为一致。
- [x] 测试覆盖 RunBus error 回放、前端 loading 退出、WS 代理配置和只有 ping 的超时兜底。

## Delivered

- `AiChatService` 后台 runner/resumer 抛错时继续发布 `kind:"error"` 到 RunBus；stream 迟到订阅者会回放 error 终态并关闭连接。
- AI 抽屉的 stream error 统一走现有错误收口：清理 `sending`、`progressHint`、`activeRun`，关闭 active stream，并展示可理解错误。
- `connectWs` 增加可选 idle timeout：只有服务端 `ping` 不算业务进展，超过等待窗口后关闭 socket 并触发抽屉超时错误。
- `AiDrawer.svelte` 把 idle timeout 回调透传到底层 WS 客户端；超时文案为“AI 响应超时，请重试。”。
- Vite `/api` 代理已开启 `ws: true`，既有配置测试覆盖 `/api/chat/stream` upgrade。

## Blocked by

- `.scratch/mastra-router-migration/issues/07-per-run-caller-session.md`
- `.scratch/mastra-router-migration/issues/08-workflow-run-auth-persistence.md`
