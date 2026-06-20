Status: needs-triage
Label: needs-triage

# VO-11 — 创建工作区 + 说目标 → 自动开岗（Workspace Scope Module）

## Parent

`.scratch/virtual-office/PRD.md`

## What to build

把整个产品 pitch 兑现到安全 tracer：**用户只要"创建 workspace + 导入数据 + 写目标"，系统自动开岗并产出第一轮结构方案 / 汇报**。需要建表 DDL 时，用发出指令者的当前 workspace session 执行；没有 active session 时留下待确认意图。

### 流程

1. 既有"新建 workspace"对话框新增一栏 "目标"（多行 textarea）。
2. 同时引导（可跳过）"导入数据"——若导入则进入既有 import 流程。
3. 提交后浏览器：
   a. 调 `/api/workspaces`（input 含 `workspaceName`, `workspaceSlug`）；后端创建 workspace 并切 token scope。
   b. silent refresh 拿新 token → enterWorkspace。
   c. 浏览器以 admin access：
      - `INSERT office_role` 三条（manager / analyst / form-officer）。
      - 调后端 `POST /api/workspaces/:slug/employees` 三次（dispatcher 写 employee_credential + 同步缓存）。该 endpoint 内部用 root + admin 协作完成"INSERT user kind=virtual + INSERT employee_credential"。
      - `INSERT office_task { assignee: manager, goal: '<目标>，请规划下一步', status: 'open' }`——**不手工传 assigner**：浏览器是 admin JWT 会话（`$auth` 为 NONE），assigner 由 `DEFAULT fn::current_user()` 按 `$token.sub` 反查填为发起的管理员。
   d. dispatcher LIVE 命中该 task → 自然拉起第一次执行窗口；浏览器办公室页 LIVE 订阅看到员工陆续上岗 + 第一条 message。
4. 前端跳转到办公室页（Web 路由），通过浏览器直连 LIVE 看实时进展。

### Schema 增量

`goal` 字段落在 ws db 的 workspace metadata 表；IdP 不保管 workspace 元数据。

在 workspace template 新增量（**版本号按 `index.ts` manifest 末尾顺延，当前已到 009，故 ≥010**；旧稿写的 `004-tables-vo.surql` 已过时，004 槽位是 workflow-run）新增 `workspace_meta` 单例表：

```surql
DEFINE TABLE workspace_meta SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR update WHERE $auth.is_admin = true;
DEFINE FIELD goal ON workspace_meta TYPE option<string>;
DEFINE FIELD created_at ON workspace_meta TYPE datetime VALUE time::now();
-- 实际只 CREATE workspace_meta:default 一条记录
```

注：`FOR update WHERE $auth.is_admin = true` 对 admin JWT 会话恒 false（admin `$auth=NONE`）——真人 admin 写 goal 靠 JWT 超级会话绕过 PERMISSIONS，该子句只对（未来可能的）RECORD-admin 生效。goal 的写入发生在 3.c 的 admin 会话内，没问题。

### 文案

- 对话框副标题："写下你希望这个工作区达成什么。员工会朝这个目标去推进。"
- 创建中 toast："员工正在上岗……"
- 跳转后引导气泡："这是你工作区的办公室。任何更新都会在这里实时出现。"

## Acceptance criteria

- [ ] 创建工作区 + 填目标 + 跳过导入 → 30s 内办公室页面出现 3 个员工 + ≥1 条 office_message。
- [ ] 同上 + 导入 .xlsx → 5 分钟内出现 ≥1 条 `office_report`（项目经理或数据分析师写的），内容包含结构方案、DDL 执行结果，或缺少 active admin session 时的待确认事项。
- [ ] 不填目标也能创建工作区（保持兼容），只是不自动 seed 员工。
- [ ] 创建失败由 `/api/workspaces` 返回明确错误；浏览器不执行 `REMOVE DATABASE`，后端负责补偿。
- [ ] dispatcher 在新员工出现后 ≤30s 内开始处理第一条 task。

## Blocked by

- `.scratch/virtual-office/issues/06-project-manager-role-bundle.md`
- `.scratch/virtual-office/issues/07-data-analyst-role-bundle.md`
- `.scratch/virtual-office/issues/08-form-officer-role-bundle.md`
- `.scratch/virtual-office/issues/09-office-ui-roster-and-activity-stream.md`
- `.scratch/web-frontend-migration/issues/06-create-workspace-flow.md`

## Notes

- 这是产品 hero flow——验收时建议把 demo 录屏归档到 `.scratch/virtual-office/demo/`。
- "调后端 `POST /api/workspaces/:slug/employees`"是因为 `employee_credential` 表 PERMISSIONS NONE，admin 也写不了，必须 root；后端在该 endpoint 内部用 root 写 secret + dispatcher 缓存。
- 创建失败回滚由 Workspace Scope Module 主导；浏览器没有 NS-admin token。
- 3.a 调 `/api/workspaces` 是否被允许，取决于调用者 OIDC token 的 `can_create_workspace` claim（IdP 登录 hook 注入）+ `_system.system_admin` allowlist——这条授权链路属 `/api/workspaces` 内部，VO-11 不重复实现，但 onboarding 入口在 UI 上应对"无创建权限"的用户隐藏/禁用。详见记忆 idp-hook-claim-system-admin。
