Status: done

## Parent

`.scratch/home-redesign/issues/07-activity-panel.md`

## What to build

把 `ActivityPanel.svelte` 的「动态」tab 从 mock 数据接到真实 `activity_event`，并通过 LIVE 订阅实时刷新。前端只读，不写动态（写入由 HR-14 / HR-15 的引擎 event 负责）。

读取层（纯逻辑 + runes 镜像，TDD）：

- 初次加载 `SELECT * FROM activity_event ORDER BY created_at DESC LIMIT 50`（PERMISSIONS 已兜底，查询不带鉴权过滤）。
- LIVE 订阅 `activity_event`（浏览器直连 `getSurreal().liveTable`），新事件到达即插入列表头；组件卸载时退订。
- actor 显示名：一次性 `SELECT id, display_name, email, kind FROM user` 建 id→显示名映射（动态行存的是 `record<user>`）。
- 渲染层把行映射成中文文案（`verb` → "新建了工作簿「X」" / "添加了 N 条记录" 等），复用现有 `formatRelativeTime`。
- **窗口聚合**：同一 actor 在短时间窗口（如 5 分钟）内对同一表的 `record.write` 合并成一条"添加了 N 条记录"，避免逐行刷屏。聚合在渲染层做。
- 删除 `activity-panel.ts` 里的 `MOCK_ACTIVITY_ENTRIES`；保留 `ActivityEntry` / `formatRelativeTime` 并复用。
- loading / 空态（"暂无动态"）齐全。

> 保持 `home-layout.test.ts` 的结构断言不破（面板 280px、只在 home 页挂载一次）。RecordId 跨 SDK 边界规则见 `web/src/lib/record-id.ts`。

## Acceptance criteria

- [ ] 动态 tab 渲染真实 `activity_event`，不再有 mock 数据（`MOCK_ACTIVITY_ENTRIES` 删除）
- [ ] 初次进入加载最近 50 条，按 `created_at DESC` 排序
- [ ] LIVE 订阅生效：新写操作产生的动态实时出现在列表头；组件卸载时退订
- [ ] actor 显示真实用户昵称 / 邮箱回退；AI / 虚拟员工动态正确标注
- [ ] 同人短时窗口同表的 record.write 聚合成"添加了 N 条记录"
- [ ] loading 态与"暂无动态"空态齐全
- [ ] 读取层纯逻辑单测覆盖（行→文案映射、聚合逻辑），web 测试全绿
- [ ] `home-layout.test.ts` / 现有 activity-panel 测试不破，svelte-check 无类型错误

## Blocked by

- HR-14 `activity_event` schema + 静态表 event

（可与 HR-15 并行；无 HR-15 时动态 tab 仍可用，只是缺记录级条目）
