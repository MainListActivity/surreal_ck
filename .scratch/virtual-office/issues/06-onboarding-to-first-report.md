Status: ready-for-agent
Label: ready-for-agent

# 06 — 从创建 workspace 到首份报告的幂等 onboarding

**What to build:** 把已有 workspace 创建/token 切换、目标设置、可选 Excel 导入和办公室 bootstrap 串成完整首次体验。用户进入新 database 后先保存目标与 primary contact，成功导入或明确跳过，再提交一个可恢复的幂等开岗动作；最终看到项目经理进度和首份报告，并可继续开岗数据分析师完成 DDL intent tracer。

**Blocked by:** virtual-office/03 — 人类请求一次性解决闭环；virtual-office/04 — 办公室实时花名册与活动页；virtual-office/05 — 数据分析师提出、浏览器管理员确认 DDL；virtual-employee-runtime/06 — 连接监督、观测与容量闭环。

**Status:** ready-for-agent

- [ ] 新建 workspace 后沿用现有 token scope 切换并以 admin access SIGNIN 新 database，不引入后端业务 CRUD 或 NS-admin 路径。
- [ ] onboarding 明确收集 goal，记录首次合法 primary contact；刷新或重试不会把 primary contact 静默换成后来访问者。
- [ ] Excel 导入成功或用户明确 skip 前，初始办公室任务不会创建；导入失败保留可重试状态且不显示开岗成功。
- [ ] 一次稳定 bootstrap key 串联 metadata、项目经理 lifecycle 和初始任务；在任意步骤超时/刷新后重试都收敛到一个 manager 和一个 initial task。
- [ ] 默认只展示项目经理和数据分析师；不存在不可用的表单专员选项或指向占位 form route 的流程。
- [ ] 接受初始任务后 30 秒内出现可见进度、健康依赖下 5 分钟内出现 substantive report；超时能区分模型、数据库、预算和员工状态原因。
- [ ] 首份报告后，用户可在同一办公室继续完成一次“分析任务 → DDL intent → admin 确认 → 分析师报告”闭环。
- [ ] 端到端测试覆盖导入、skip、导入失败、各步骤刷新、重复提交、已有 bootstrap、断线恢复和 workspace 切换。
- [ ] 发布前更新虚拟办公室 ADR，使其与需求拆分、通用通知和 browser-confirmed DDL 决策一致。
