Status: done
Label: done

# OIP-17 — 债权审核摘要、风险与待办建议

## Parent

`.scratch/operating-iteration-plan/PRD.md`

## What to build

用模板包数据中的领域提示和快捷任务组合出三条销售演示路径：生成单条债权审核摘要、生成风险清单、根据缺失材料与截止日期提出待办建议。平台行分析 agent 保持通用，债权字段语义、检查重点和输出提示全部从当前工作簿模板读取；任何字段补全或待办写入继续走确认卡。

## Acceptance criteria

- [x] 模板包可提供行分析领域背景、字段语义和检查重点，平台 prompt 中不新增法律硬编码。
- [x] 选中债权记录后可生成包含申报金额、审核状态、材料情况和引用依据的摘要。
- [x] 风险清单区分缺失信息、金额异常、疑似重复和期限风险，并说明判断依据。
- [x] 待办建议可以形成写入提案，但只有用户确认后才创建或更新记录。
- [x] 有关联资源时回答展示 citation；无资源时明确区分台账事实和模型建议。
- [x] 非模板工作簿及无领域提示模板继续使用通用行分析，不出现债权措辞。
- [x] 测试使用 fake 模型验证 instructions 装配、确认边界及无模板回退，不调用真实模型。

## Delivered

- 新增模板 `row_analysis` 数据契约与 workspace schema 增量；破产债权模板声明领域背景、字段语义、四类风险检查重点和回答边界。
- 通用行分析 agent 按当前工作簿、调用者 workspace session 动态装配模板 instructions；空白工作簿和无提示模板保持通用 prompt。
- 破产债权模板新增审核摘要、风险清单和审核待办三条优先快捷任务；关联资源 citation 继续通过 Router workflow 到达最终消息。
- 新增通用 `record-write-proposal` 创建/更新意图与 `proposeRecordWrite` tool；workflow 在写入前暂停，确认卡确认后才调用前端数据表运行时。
- fake 模型覆盖 instructions 装配与无模板回退；Router、暂停事件和确认卡测试覆盖摘要 citation 及确认前零业务写入。

## Blocked by

- `.scratch/operating-iteration-plan/issues/09-template-quick-tasks.md`
- `.scratch/operating-iteration-plan/issues/15-ai-retry-and-confirmation-recovery.md`
- `.scratch/operating-iteration-plan/issues/16-resource-record-association.md`
