Status: needs-triage
Label: needs-triage

# VO-07 — 数据分析师 岗位与 tool bundle

## Parent

`.scratch/virtual-office/PRD.md`

## What to build

新增 **岗位** `data-analyst`，能：

1. 收到来自项目经理的 **派单**（如 "把导入的 .xlsx 建成数据表 + 起一个回访统计仪表盘草稿"）
2. 通过既有 dashboard / claim-analysis tool 完成"建数据表 + 仪表盘草稿"
3. 完成后回写 **派单** `result` + 给项目经理写 **汇报**

### Bundle `analyst-basics`

新建 `server/ai/office/tool-bundles/analyst-basics.ts`：

- 复用 issue 04（agentic-ai-product）`navigation-tools.ts` 中的 `inspectSchema` / `searchRecord`
- 复用 issue 05（agentic-ai-product）`dashboard-tools.ts` 中的 `generateDashboardDraft`
- 复用 issue 06（agentic-ai-product）`claim-analysis-tools.ts` 中的 `analyzeClaimRow` / `fetchRelatedRecords`
- 复用 manager-basics 的 `postOfficeReportTool`（不带 `createOfficeTaskTool`——数据分析师不派单给别人）

新增本岗位特定 tool：

- `createDataSheetFromImportTool` — input: `{ workbookId, sourceImportId, suggestedName }`，调用既有"导入解析后落 sheet"服务（本 issue 不重写，只暴露为 tool）

### 与既有架构的衔接

dashboard-tools 当前是 router workflow 用的；本 issue 在 bundle registry 里注册同一份 tool，dispatcher 拉起时按 `tool_bundle_key='analyst-basics'` 装配。**tool 实现本身零修改**，只是挂载点新增。

## Acceptance criteria

- [ ] 项目经理派单"建 customer_visit 数据表"后，data-analyst 窗口在 ≤3 步内：建表成功 → 写 result → 写 report
- [ ] data-analyst 用 `inspectSchema` 看到的 schema 已包含他刚建的表（即 confirmed 产出与 schema 同步）
- [ ] 集成测试：从 xlsx 导入到 sheet 建好 + 仪表盘草稿出现，全流程无人工干预
- [ ] tool bundle registry 里 `analyst-basics` 的导出与 `manager-basics` 完全不重叠，无意外 tool 越权

## Blocked by

- `.scratch/virtual-office/issues/06-project-manager-role-bundle.md`
- `.scratch/agentic-ai-product/issues/05-ai-dashboard-draft.md`（已 done）
- `.scratch/agentic-ai-product/issues/06-claim-row-analysis.md`（如未 done，则本 issue 中相关验收降级为可选）

## Notes

- 不在本 issue 处理"分析师识别哪些字段需要补全 → 通知表单专员"，留给 issue 08 完成后做一次端到端串联测试。
