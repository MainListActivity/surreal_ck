Status: ready-for-agent
Label: ready-for-agent

# AI-005 — AI 仪表盘草稿生成：预览前确认再保存

## Parent

`.scratch/agentic-ai-product/PRD.md`

## What to build

注册 schema 检查和仪表盘草稿生成两个 Mastra tool，AI 输出复用已有 dashboard-builder 合约的草稿意图，用户预览后确认保存。

**Tool 列表**（注册到 `src/main/ai/mastra/tools/`）：
- `inspectSchema`：读取当前工作空间可用的业务表和字段定义，调用 `table-schema` 服务，供 agent 理解数据结构
- `generateDashboardDraft`：根据用户描述生成仪表盘视图草稿，输出 `DashboardDraftIntent`

**DashboardDraftIntent 结构**（复用 dashboard-builder 合约）：
```ts
type DashboardDraftIntent = {
  type: 'dashboard-draft'
  title: string
  description: string
  widgetSpec: DashboardViewBuilderSpec  // 复用已有 builder 类型
  explanation: string   // AI 对该图表度量内容的说明
}
```
- 优先使用 builder-style spec（图表类型、指标、维度、过滤、排序、limit）
- 仅当必要时使用 raw SQL，且走已有 `dashboard-query` 验证管道

**Renderer 交互**：
- AI 返回 `DashboardDraftIntent` 时，抽屉展示草稿预览卡片（含 explanation 和小部件预览）
- 用户点击"保存到仪表盘"后调用 `ai.executeAction`，主进程调用已有 dashboard 保存服务落库
- 用户可忽略草稿，不保存不影响现有仪表盘

## Acceptance criteria

- [ ] 用户描述"按月统计债权申报金额趋势"，AI 返回含 widgetSpec 的草稿意图
- [ ] 抽屉显示草稿预览卡片，包含 explanation 文字说明
- [ ] 预览卡片复用已有 widget 渲染组件（TimeSeriesWidget 等）
- [ ] 用户确认保存后，仪表盘出现在仪表盘列表中
- [ ] raw SQL 草稿经过 `dashboard-query` 验证，不通过则返回错误提示而非保存
- [ ] AI 生成的仪表盘与手动创建的仪表盘在产品行为上一致（可编辑、可删除）
- [ ] 仪表盘生成适配器服务测试：验证 builder spec 到 widget 渲染的转换正确性

## Blocked by

- `.scratch/agentic-ai-product/issues/11-router-workflow-and-sub-agents.md`

## Mounting note (added during PRD revision)

本 issue 的 `inspectSchema` 和 `generateDashboardDraft` 两个 tool 必须挂载在 issue 011 创建的 `dashboardAgent` 上，**不挂载在 navigationAgent 或任何统一 agent 上**。子 agent 拆分纪律：DashboardAgent 的 system prompt 只描述 schema inspection + draft generation 两类能力，不引入导航或行分析的领域知识。

所以本 issue 的实现顺序变为：011 完成 → 本 issue 在 dashboardAgent 上挂 tool → 端到端测试。
