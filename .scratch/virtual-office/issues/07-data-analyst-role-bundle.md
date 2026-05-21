Status: needs-triage
Label: needs-triage

# VO-07 — 数据分析师 岗位与 tool bundle

## 2026-05-21 DDL 授权决策

当前 workspace-as-database 模型规定 **虚拟员工** 走 `employee` access，DB 引擎能力仅 DML。建数据表 / 定义字段属于 DDL，执行权限来自发出指令的真人用户，而不是虚拟员工。

因此 data-analyst 的 DDL 路径是：先产出结构化 DDL 意图，再由发出指令的真人当前 workspace session 执行。若该 session 是 admin access，则 DDL 成功；若是 participant access，则由 SurrealDB 引擎拒绝。Office dispatcher 后台没有可用真人 session 时，只能写待确认意图 / 用户通知请求。

## Parent

`.scratch/virtual-office/PRD.md`

## What to build

新增 **岗位** `data-analyst`，能：

1. 收到来自项目经理的 **派单**（如 "把导入的 .xlsx 起草成数据表结构方案 + 起一个回访统计仪表盘草稿"）
2. 通过既有 dashboard / claim-analysis tool 完成"数据表结构方案 + DDL 待确认意图 + 仪表盘草稿"
3. 完成后回写 **派单** `result` + 给项目经理写 **汇报**

### Bundle `analyst-basics`

新建 `server/ai/office/tool-bundles/analyst-basics.ts`：

- 复用 issue 04（agentic-ai-product）`navigation-tools.ts` 中的 `inspectSchema` / `searchRecord`
- 复用 issue 05（agentic-ai-product）`dashboard-tools.ts` 中的 `generateDashboardDraft`
- 复用 issue 06（agentic-ai-product）`claim-analysis-tools.ts` 中的 `analyzeClaimRow` / `fetchRelatedRecords`
- 复用 manager-basics 的 `postOfficeReportTool`（不带 `createOfficeTaskTool`——数据分析师不派单给别人）

新增本岗位特定 tool：

- `proposeDataSheetFromImportTool` — input: `{ workbookId, sourceImportId, suggestedName }`，读取导入解析结果并输出字段、类型、示例记录、风险提示和待确认 DDL/导入方案。
- `executeDdlWithIssuerSessionTool` — input: `{ ddlIntentId }`，只在当前 runtime 明确携带发出指令者的 workspace session 时可用；用该 session 执行 DDL。没有真人 session 时返回 `needs-human-authorization`，由 UI 或用户通知请求接管。

### 与既有架构的衔接

dashboard-tools 当前是 router workflow 用的；本 issue 在 bundle registry 里注册同一份 tool，dispatcher 拉起时按 `tool_bundle_key='analyst-basics'` 装配。**tool 实现本身零修改**，只是挂载点新增。

## Acceptance criteria

- [ ] 项目经理派单"为 customer_visit 起草数据表结构"后，data-analyst 窗口在 ≤3 步内：产出结构方案 → 产出 DDL intent → 写 result → 写 report。
- [ ] 当 runtime 有发出指令者的 admin workspace session 时，`executeDdlWithIssuerSessionTool` 用该 session 执行 DDL，执行身份 / 审计归因到发出指令者。
- [ ] 当发出指令者是 participant 或 token scope 非 admin 时，DDL 被 SurrealDB 引擎拒绝，tool 返回明确错误，不降级为 root / employee 写入。
- [ ] 当后台执行窗口没有可用真人 session 时，tool 返回 `needs-human-authorization`，并写用户通知请求或 pending intent；员工 session 不执行 DDL。
- [ ] tool bundle registry 里 `analyst-basics` 的导出与 `manager-basics` 完全不重叠，无意外 tool 越权

## Blocked by

- `.scratch/virtual-office/issues/06-project-manager-role-bundle.md`
- `.scratch/agentic-ai-product/issues/05-ai-dashboard-draft.md`（已 done）
- `.scratch/agentic-ai-product/issues/06-claim-row-analysis.md`（如未 done，则本 issue 中相关验收降级为可选）

## Notes

- 不在本 issue 处理"分析师识别哪些字段需要补全 → 通知表单专员"，留给 issue 08 完成后做一次端到端串联测试。
- DDL 永远不使用 root、service JWT 或 employee session。所有权限来自发出指令者的当前 workspace session。
