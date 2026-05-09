Status: ready-for-agent
Label: ready-for-agent

# AI-006 — 债权行分析：字段补全提案 + 确认写入

## Parent

`.scratch/agentic-ai-product/PRD.md`

## What to build

注册债权行分析 Mastra tool，AI 分析当前选中行并输出字段补全提案，用户逐字段确认后通过已有 row upsert 服务写入。

**Tool 列表**（注册到 `src/main/ai/mastra/tools/`）：
- `analyzeClaimRow`：读取当前选中行的全部字段值和字段定义，识别空白/不一致字段，生成 `RowPatchProposal`
- `fetchRelatedRecords`：根据行中的关联字段（如企业、案件 ID）查询相关引用记录，调用 `references` 服务，为分析提供上下文

**RowPatchProposal 结构**：
```ts
type RowPatchProposal = {
  type: 'row-patch-proposal'
  recordId: string
  proposals: Array<{
    field: string
    currentValue: unknown
    suggestedValue: unknown
    basis: string        // AI 给出建议的依据说明
    confidence: 'high' | 'medium' | 'low'
  }>
}
```
- proposals 中只包含可编辑字段（不含系统字段、只读字段）
- 低置信度建议仍作为提案展示，但视觉上标记区分

**Renderer 交互**：
- AI 返回 `RowPatchProposal` 时，抽屉展示提案卡片，每个字段显示当前值、建议值和依据
- 用户可逐字段选择"接受"或"忽略"
- 点击"确认写入"后，仅把已接受的字段变更通过 `ai.executeAction` 发送主进程，主进程调用已有 row upsert 服务
- 点击"全部忽略"或关闭卡片，行数据不变

## Acceptance criteria

- [ ] 选中一条债权行后，用户输入"分析这条记录"，AI 返回 `RowPatchProposal`
- [ ] 提案卡片展示每个建议字段的当前值、建议值、依据和置信度
- [ ] 只读字段和系统字段不出现在提案中
- [ ] 用户接受部分字段、忽略其他字段后，只有接受的字段被写入数据库
- [ ] 全部忽略时行数据不发生任何变更
- [ ] 写入通过已有 row upsert 服务，字段约束、RecordId 序列化、DateTime 转换保持一致
- [ ] `fetchRelatedRecords` 在有关联引用时被调用，分析结果包含关联信息
- [ ] 测试：提案结构仅含可编辑字段；patch 应用测试复用已有 editor/data-table-runtime 测试模式

## Blocked by

- `.scratch/agentic-ai-product/issues/11-router-workflow-and-sub-agents.md`

## Mounting note (added during PRD revision)

本 issue 的 `analyzeClaimRow` 和 `fetchRelatedRecords` 两个 tool 必须挂载在 issue 011 创建的 `claimAnalysisAgent` 上，**不挂载在 navigationAgent / dashboardAgent 或任何统一 agent 上**。子 agent 拆分纪律：ClaimAnalysisAgent 的 system prompt 只描述当前行字段补全 + 关联记录查询两类能力，不引入导航、仪表盘或闲聊的领域知识。

所以本 issue 的实现顺序变为：011 完成 → 本 issue 在 claimAnalysisAgent 上挂 tool → 端到端测试。

写入路径仍然走 `ai.executeAction`（写操作前确认），由 issue 012 的暂停/恢复机制保证 RowPatchProposal 在用户确认前不落地。
