Status: ready-for-agent
Label: ready-for-agent

# AI-007 — AI 上下文快照测试套件

## Parent

`.scratch/agentic-ai-product/PRD.md`

## What to build

为 `src/shared/ai-context.ts` 和上下文快照构建逻辑补充完整的单元测试套件，覆盖所有选中状态变更场景，确保快照不产生陈旧数据。

**测试场景覆盖**：
1. `no-selection`：未进入工作簿，快照中 workbook/sheet/selectedRow 均缺失
2. `workbook-only`：进入工作簿但未选中 Sheet，快照含 workbook，sheet/selectedRow 缺失
3. `sheet-selected`：选中 Sheet 未选中行，快照含 workbook + sheet，selectedRow 缺失
4. `row-selected`：选中行，快照含完整 workbook + sheet + selectedRow（含 label 和 visibleValues）

**陈旧状态验证**：
- 切换 Sheet 后，快照中 sheet 更新为新 Sheet，selectedRow 清除
- 取消行选中后，快照退回到 sheet-selected 状态
- 切换工作簿后，快照中 sheet 和 selectedRow 均清除

**stable identifier 验证**：
- selectedRow.label 按字段优先级正确拼接（name > code > id）
- selectedRow.id 使用 RecordId 字符串形式，不随 JS 对象引用变化

所有测试不依赖真实 LLM 调用或 API key，使用确定性输入验证输出结构。

## Acceptance criteria

- [ ] 4 种选中状态各有独立测试用例，断言快照字段的存在性和正确值
- [ ] 切换 Sheet 后的测试验证 selectedRow 被清除
- [ ] 切换工作簿后的测试验证 sheet 和 selectedRow 均被清除
- [ ] stable identifier 测试验证字段优先级（name 字段存在时不使用 code 或 id）
- [ ] 所有测试无网络请求，无 LLM 依赖
- [ ] 测试与 AI-002 实现的逻辑保持一致，不测试私有实现细节

## Blocked by

- `.scratch/agentic-ai-product/issues/02-ai-context-snapshot.md`
