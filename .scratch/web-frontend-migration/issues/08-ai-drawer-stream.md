Status: needs-triage
Label: needs-triage

# WP-D2-08 — AI 抽屉接 chat/stream

## Parent

`.scratch/web-frontend-migration/PRD.md`

## What to build

把 `web/legacy/` 中既有 AI 抽屉 UI 搬到 `web/src/components/AiDrawer.svelte` + 关联子组件，并把所有 Electrobun RPC 替换为：

- 发消息：`api.api.chat.$post({ json: { message, contextSnapshot? } })` 拿 `{ runId, streamUrl }`。
- 监听：用 `lib/ws.ts` 连 `streamUrl`（指向后端 `/api/chat/stream?runId=...`），渲染 progress / chunk / suspend / done 事件。
- suspend 用户决策：UI 弹候选选择 → 调 `POST /api/chat/runs/:runId/resume { decision }`。

UI 行为保持与既有抽屉一致（流式 markdown、候选选择卡、tool call trace）。

## Acceptance criteria

- [ ] 在某 workspace 内打开抽屉，输入 "打开工作簿 X"。
- [ ] 前端立即显示"路由中…"进度提示，随后 chunk 流式出现。
- [ ] Router workflow done 后渲染最终 message + citations。
- [ ] suspend 场景：UI 显示候选列表；点选某项 → 后端继续推进 → done。
- [ ] 切换 workspace 时未完成的 chat 会话被关闭（WS 主动 close）。

## Notes

- 进入抽屉前未必有具体 contextSnapshot；MVP 传一个最小 snapshot `{ workspaceSlug, route: { screen: 'workspace' } }` 即可。完整 snapshot 与 sidecar 字段瘦身留给未来 issue。
- 长消息 markdown 渲染保留既有方案（marked / shiki / 其它），但要确认无 dom xss（用户输入 + AI 输出都走 sanitize）。
