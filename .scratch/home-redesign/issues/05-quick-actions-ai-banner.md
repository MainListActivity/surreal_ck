## What to build

在 `HomeScreen` 主内容区新增两个固定区块：快捷操作卡片组和 AI 能力 banner。

**QuickActionCards**（工作簿列表上方）：三张横排卡片——「空白工作簿」（调用现有新建流程）、「从模板创建」（跳转模板库页面）、「导入文件」（stub，显示"敬请期待"提示）。每张卡片带图标色块 + 标题 + 副标题。

**AiBanner**（QuickActionCards 上方或 greeting 下方）：横幅卡片，内容说明 AI 能生成 SurrealQL 并直接操作数据表结构和数据；右侧有「开始对话」按钮，点击触发 `AiDrawer` 展开（通过现有 `onopenaichat` prop / 全局事件）。banner 样式带品牌渐变背景色，不可关闭（常驻）。

**Greeting 区域**更新：显示当前时段问候语（早上好/下午好/晚上好）+ workspace 名称（可点击触发切换面板，由 HR-03 接线）+ SurrealDB 连接状态 dot（已连接=绿点/断开=红点，复用 `getConnectionState()`）。

## Acceptance criteria

- [ ] 三张快捷操作卡片渲染正确，「空白工作簿」可发起新建，「导入文件」显示 stub 提示
- [ ] AI banner 常驻显示，「开始对话」按钮触发 `AiDrawer`
- [ ] greeting 显示时段问候语 + workspace 名称 + 连接状态 dot
- [ ] 连接状态 dot 在 `connected` 时绿色，`disconnected` 时红色
- [ ] svelte-check 无类型错误

## Blocked by

- HR-01 三栏无 topbar 布局骨架
