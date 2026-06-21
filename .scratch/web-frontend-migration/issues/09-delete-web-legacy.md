Status: done
Label: needs-triage

# WP-D2-09 — 删 web/legacy

## Parent

`.scratch/web-frontend-migration/PRD.md`

## What to build

- 删除 `web/legacy/`。
- `pnpm --filter @surreal-ck/web typecheck` 与 `svelte-check` 0 错误。
- AGENTS.md / CLAUDE.md 中"Project Structure"前端段落更新为 `web/src/**`。
- README 截图（可选）更新。

## Acceptance criteria

- [ ] `web/legacy/` 不存在。
- [ ] svelte-check 0 错误。
- [ ] 端到端：dev server 起 + 登录 + 进 workspace 首页 + 打开工作簿看到表格 + AI 抽屉发消息 → 全程无 console error。
- [ ] 07i 的页面 / 按钮 inventory 已核对；legacy 中用户可见入口要么已迁，要么在新 web 中有占位和后续 issue 归属。
- [ ] 既有测试（如有）全过。

## Notes

- 删之前 grep 确保没有任何 `import .* from 'web/legacy'` / 路径别名残留。
- 删之前用 07i inventory 核对 `web/legacy/screens/*` 和 `SideNav` 可见入口，避免静默丢页面 / 按钮。
- 完成本 issue 后簇 D2 结束；任何"工作簿增删改" / "新数据表 UI" / "LIVE 实时更新" 都由后续业务簇驱动。

## 收口（2026-06-21）

- `web/legacy/`（95 文件）已删除。删前 grep 确认 `web/src` 无任何 `import` 引用、无路径别名指向 legacy（命中全是注释/测试字样）。
- `pnpm --filter @surreal-ck/web typecheck`（含 svelte-check）：0 errors（5 个既有 `<svelte:component>` deprecation warning，与本次删除无关）。
- `pnpm --filter @surreal-ck/web test`：354 pass / 0 fail。
- 端到端浏览器冒烟（登录 → workspace 首页 → 工作簿表格 → AI 抽屉无 console error）需真实 IdP + SurrealDB，留人工验证。
