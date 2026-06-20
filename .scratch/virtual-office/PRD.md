# 虚拟办公室 PRD

更新时间：2026-05-16
对应 ADR：
- [`docs/adr/virtual-office.md`](../../docs/adr/virtual-office.md)（业务能力）
- [`docs/adr/web-only-pivot.md`](../../docs/adr/web-only-pivot.md)（架构形态）
- [`docs/adr/workspace-as-database.md`](../../docs/adr/workspace-as-database.md)（workspace ↔ database 映射 + 用户身份）

对应领域词汇：[`CONTEXT.md`](../../CONTEXT.md) §虚拟办公室 / §虚拟员工 / §岗位 / §派单 / §汇报 / §办公室消息 / §用户通知请求 / §Office dispatcher / §执行窗口 / §心跳

## 一句话

用户在 **工作区** 内导入数据并写下目标，**虚拟办公室** 中由 **岗位** 驱动的 **虚拟员工** 在云端 7×24 自治推进：清洗数据并起草结构方案 → 需要 DDL 时由发出指令的真人 session 确认执行 → 设计并发布表单 → 跟进填写情况 → 在必要时通过 **用户通知请求** 让真人打电话或寄函件 → 持续向 **上级** **汇报**。用户出门旅行只需打开浏览器看进展。

## 当前不解决

- 用户与 **虚拟员工** 在 UI 上的双向自由聊天（依赖未来"聊天功能"立项；本 PRD 只把 `office_message` 表建好，UI 仅做只读流和提及）。
- 多 **工作区** 间的员工借调（一员工一工作区，见 ADR §Open Questions）。
- 移动端原生通知推送（依赖浏览器 Push API 或后续移动 app）。
- 表单设计器本身（依赖既有 forms 模块；本 PRD 只让 **虚拟员工** 调用既有 forms tool）。
- 桌面端 / 离线编辑（参见 [`web-only-pivot.md`](../../docs/adr/web-only-pivot.md)）。

## 前置条件

本 PRD 的所有 issue 都假定下述架构层先就位（由 web-only-pivot 与 workspace-as-database 阶段的 issue 完成，详见 TODOS.md 主线）：

- `server/` 目录就位，Bun server 能跑 Router workflow。
- `web/` 目录就位，浏览器前端能登录（OIDC）+ 通过 Workspace Scope Module 列出 / 切换 workspace。
- SurrealDB 公网 WSS / 本地开发 ws 已就位；后端持有 root 凭证（仅 workspace lifecycle / _system / employee_credential 用）。
- `_system` database 已建好，含 `workspace` 索引表 + `user_workspace_index` + `_system_schema_version`。
- `POST /api/workspaces` 已实现：root 建 ws db + 应用 workspace template + 写 owner user + 写 `_system` + 切 token scope。

未完成前不开工。

## 用户路径

1. 用户在浏览器中创建 **工作区**，导入 .xlsx，写一段目标说明（"我要做 2026 财年北方区客户回访"）。
2. 后端自动在该 **工作区** 创建一组 **虚拟员工**（MVP：单一"项目经理"通才；后续按岗位拆分）。
3. **项目经理** 收到 workspace 创建事件 → dispatcher 拉起 **执行窗口** → 分析数据 → 派单给 **数据分析师**（如果已开岗）或自己继续完成 → 产出 **数据表** 结构方案 / 草稿 → 需要 DDL 时交给发出指令的真人 session 确认执行 → 设计表单 → 发表单。
4. 用户关电脑出门旅行。表单陆续被填写，**虚拟员工** 在 **心跳** 中检查填写率、识别异常。
5. 出现需要真人介入的情况，**虚拟员工** 写一条 **用户通知请求**。用户在手机浏览器中看到通知 → 处理后回写 resolution。
6. 整个过程中下属周期性向 **上级** 写 **汇报**，**上级** 周期性派新 **派单** 或升级 **用户通知请求**。

## 验收 KPI（MVP）

- 用户从"创建 workspace + 写目标"到"看到第一条 **汇报**"在 5 分钟内。
- **虚拟员工** 持续 24 小时无人值守不烧穿 token 预算（`office_role.daily_token_budget` 守住）。
- 后端容器重启后，所有未结 **派单** 自动从断点恢复，无丢失、无重复执行。
- 所有 **虚拟员工** 写操作可在 SurrealDB changefeed 中按 `$auth` 归因到具体员工。

## 与既有系统的关系

| 既有系统 | 关系 |
|---|---|
| Router workflow | 并列，不嵌套。Router 处理"用户主动发问"；本 PRD 处理"长期目标自动推进"。二者在 Bun server 进程内共享 tool registry，但使用不同的 SurrealDB 会话身份。 |
| Mastra `WorkflowsStorage` | 共享同一 adapter 实现。snapshot 落在所属 workspace database 内的 `workflow_run` 表；归属由 db 边界表达，不放 `_system`。 |
| 同步 v2 | **已取消**（见 [`web-only-pivot.md`](../../docs/adr/web-only-pivot.md)）。 |
| `app_user` 全局表 | **已废弃**。改为每个 workspace database 内一张 `user` 表。**虚拟员工** = `user.kind='virtual'`。详见 [`workspace-as-database.md`](../../docs/adr/workspace-as-database.md)。 |
| `has_workspace_member` 边 | **已废弃**。成员关系由"该 db 内有没有这条 user 记录"+"是否 admin"天然表达。 |
| 既有 4 个子 agent tool（navigation / dashboard / claim-analysis / resource-retrieval） | 复用。被组装进 `tool_bundle` 后挂载给对应 **岗位**。 |
| Electrobun 桌面端 | 整体取消。 |

### DDL 授权规则

- **虚拟员工** 的 employee access 是 RECORD 类型，引擎层只有 DML、不能 DDL。
- AI / **虚拟员工** 发起的建 **数据表**、定义 **字段**、调整 schema 等 DDL，必须使用发出指令的真人当前 workspace session 执行。
- DDL 能力由 **access 类型** 卡死：只有 admin（`TYPE JWT`，数据库级管理员）能 DDL；participant / employee（`TYPE RECORD`）无 DDL。而用户能用哪种 access，取决于 IdP 给他的 token 带的是 admin 还是 participant scope（per-workspace，由该 db 内 `user.is_admin` 决定）——普通成员拿不到 admin scope，自然 signin 不进 admin、做不了 DDL。授权关卡在 token 颁发阶段，不是运行时判 is_admin。
- 后端不保存真人长期 token，不用 root 或 service JWT 代写业务 DDL。
- 后台 **执行窗口** 没有可用真人 session 时，只能生成待确认意图或 **用户通知请求**，等待真人回来确认。

### 身份归因规则（统一基线，2026-06-20 校正）

- **谁能拿到 admin token 由 IdP 认证阶段卡死**：IdP 颁发 token 前调后端用户身份接口，后端按**该 workspace db 内** `user.is_admin` 决定是否给该 db 颁发 admin scope（per-workspace 粒度，见 `server/src/workspaces/workspace-scope.ts` getDefaultScope）。普通成员的 token 只带 participant scope。所以"能 signin 某 db 的 admin access"本身就等价于"是该 workspace 的管理员"。
- **admin 是 `TYPE JWT` access：会话的 `$auth` 为 NONE**，是数据库级管理员——不论 PERMISSIONS 为何，能读写任何数据、修改任何表结构（DDL）。它不受 record-level PERMISSIONS 约束。
- **participant / employee 是 `TYPE RECORD` access：`$auth` = 对应 user record**，逐条受表 PERMISSIONS 约束。
- office_* / workflow_run 等表的归因字段统一用 `DEFAULT fn::current_user()`（见 `shared/sql/workspace-template/009-fn-current-user.surql`）：RECORD 会话返回 `$auth`，admin JWT 会话按 `$token.sub` 反查 user record。**不要再写 `DEFAULT $auth`**——admin 路径会因 `$auth=NONE` 写入失败。
- PERMISSIONS 子句里的 `$auth.is_admin = true` 兜底分支对 admin JWT 会话恒 false（admin `$auth=NONE`）；真人 admin 靠超级会话绕过整张表 PERMISSIONS 完成兜底，不依赖该分支。保留只为表达意图。
- "谁能开员工 / 谁是管理员"这类授权**靠"能否 signin 该 db 的 admin access"判定**（关卡在 token 颁发阶段，已前移），endpoint 只需 signin 失败即拒，不需在应用层再查 is_admin（见 issue 03）。

## 主要风险

1. **SurrealDB root 凭证保管**：后端唯一长期凭证，仅 workspace lifecycle、_system、employee_credential 等维护路径用；环境变量 + 不写日志。
2. **每员工一条 SurrealDB 连接**：dispatcher 维护"workspace × employee"数量的连接，MVP 数千内 OK；上万要重新设计。
3. **岗位互派形成环**（issue 05 在 dispatcher 加深度上限 + 频率上限）。
4. **token 烧穿**——必须在第一阶段就上预算（issue 05 闸门 + issue 09 仪表）。
5. **单实例瓶颈**：MVP 后端单副本，进程挂掉 = 全部工作区虚拟办公室全停。监控 + auto-restart 是底线。
6. **schema 升级分发**：业务表升级要遍历所有 workspace database 跑迁移；migration runner 是 launch-critical。

## Issue 路线图

按 tracer 顺序，每一期都能跑通最小通路。

| # | 名称 | 主体 | 依赖 |
|---|---|---|---|
| 01 | workspace-template schema | 在 `shared/sql/workspace-template/` 中加入 `user`（含 kind/virtual_profile/is_admin）+ `office_role` 表 | WP-C-02 |
| 02 | office collaboration tables | `office_task` / `office_message` / `office_report` / `user_notification` 四张表，作为 ws db schema seed 的一部分 | 01 |
| 03 | employee provisioning endpoint | 后端 HTTP endpoint：admin 调用 → 在指定 ws db 内 INSERT 一条 `kind='virtual'` user 记录 + 写 secret + 关联 role | 01 |
| 04 | office dispatcher tracer | dispatcher 骨架 + 一个 echo 岗位 + 跨 workspace 枚举 + 员工 SIGNIN + LIVE SELECT + 心跳 | 02, 03 |
| 05 | budget & loop guard | 每窗口步数硬上限 + daily_token_budget + 任务深度上限（计数表在每个 ws db 内） | 04 |
| 06 | project-manager role bundle | MVP 岗位"项目经理"：派单、汇报、用户通知请求三件套 tool | 04 |
| 07 | data-analyst role bundle | 调用既有 dashboard / claim-analysis tool 完成"数据表结构方案 + 授权发起人 session 执行 DDL + 仪表盘草稿" | 06 |
| 08 | form-officer role bundle | 创建/发布表单 + 跟进填写率（依赖既有 forms 模块的 tool 暴露） | 06 |
| 09 | office UI: roster + activity stream | workspace 级"办公室"页面（Web 路由）：员工花名册、消息流、任务看板，浏览器直连 SurrealDB LIVE | 04, 06 |
| 10 | user_notification inbox | Web 抽屉新增 inbox tab；resolution 浏览器直连 SurrealDB 闭环 | 02, 09 |
| 11 | onboarding wizard | 浏览器内"导入数据 + 写目标"引导 → 调 `/api/workspaces` + 自动开三岗位 + 触发首次 **执行窗口** | 06, 07, 08, 09, WP-C-06 |

非阻塞延后项：

- 多岗位互派的可视化（DAG 视图）。
- **虚拟员工** 双向聊天 UI（等聊天功能整体立项）。
- 浏览器 Web Push 推送 + 移动端原生 app。
- Workspace Scope Module 成员管理 UI 与 `_system.user_workspace_index` 同步策略。
- 后端多副本 + leader 选举。
