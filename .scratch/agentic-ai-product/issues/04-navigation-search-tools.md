Status: ready-for-agent
Label: ready-for-agent

# AI-004 — 导航与资源搜索 Mastra tools

## Parent

`.scratch/agentic-ai-product/PRD.md`

## What to build

在 workspace agent 上注册 4 个导航/搜索类 Mastra tool，并在 AI 抽屉侧渲染对应的确认交互卡片。

**Tool 列表**（注册到 `src/main/ai/mastra/tools/`）：
- `navigate`：跳转到指定功能页面（HomeScreen、SettingsScreen 等），调用 `ai.executeAction` 中的路由跳转能力
- `searchWorkbook`：按名称或业务含义搜索工作簿，调用已有 `workbooks` 服务，返回候选列表
- `searchDashboard`：按名称搜索仪表盘，调用已有 `dashboards` 服务，返回候选列表
- `searchRecord`：在指定表中按关键字搜索记录（债权人/债权编号等），调用 `data-table-runtime` 服务

**意图结构（NavigationIntent）**：
```ts
type NavigationIntent =
  | { type: 'navigate'; route: string }
  | { type: 'open-workbook'; workbookId: string }
  | { type: 'open-dashboard'; dashboardId: string }
  | { type: 'open-record'; workbookId: string; sheetId: string; recordId: string }
  | { type: 'ambiguous'; candidates: { label: string; id: string }[] }
```

**Renderer 交互**：
- AI 返回 NavigationIntent 时，抽屉显示确认卡片（目标名称 + "跳转"按钮）
- `ambiguous` 时显示候选列表让用户选择
- 用户确认后调用 `ai.executeAction` 执行跳转；用户可忽略不跳转

## Acceptance criteria

- [ ] 用户输入"打开工作簿 XXX"，AI 返回含 workbookId 的导航意图，抽屉显示确认卡片
- [ ] 用户输入"帮我找债权人张三"，AI 返回搜索结果候选列表
- [ ] 存在多条相似记录时，返回 `ambiguous` 意图而非直接跳转
- [ ] 资源不存在时，AI 返回友好提示而非报错
- [ ] 用户确认后执行跳转；用户不操作确认卡片时主应用页面不发生变化
- [ ] 所有 tool 调用已有服务层，不直接执行 SurrealQL
- [ ] 导航意图解析测试：模糊/缺失资源返回 `ambiguous` 或空结果，不执行跳转

## Blocked by

- `.scratch/agentic-ai-product/issues/03-ai-chat-rpc-mastra-agent.md`
