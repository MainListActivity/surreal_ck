Status: done
Label: done

# OIP-09 — 数据驱动的模板快捷任务

## Parent

`.scratch/operating-iteration-plan/PRD.md`

## What to build

允许模板包声明 AI 快捷任务的显示文案、任务文本、适用数据表和操作风险类型。AI 抽屉按当前工作簿模板及当前数据表展示 3–5 个任务，点击后走既有 Router workflow，并携带当前工作区、工作簿、数据表和选中记录上下文。

## Acceptance criteria

- [x] 无模板或无快捷任务配置时，AI 抽屉保持现有通用入口，不报错也不显示垂直文案。
- [x] 有配置时只显示适用于当前模板和当前数据表的任务，切换工作簿后同步更新。
- [x] 点击任务生成一次正常 AI 请求，context 包含当前工作簿、数据表和可用的选中记录。
- [x] 查询任务直接展示结果；写操作继续进入现有确认卡；DDL 对普通成员显示管理员权限提示。
- [x] 破产债权模板的数据文件提供父 PRD 中至少五个快捷任务，平台代码不出现法律业务词汇。
- [x] 测试覆盖无模板回退、上下文切换、写确认和权限提示。

## Blocked by

- `.scratch/operating-iteration-plan/issues/08-bankruptcy-claims-template-pack.md`
