Status: needs-triage
Label: needs-triage

# VO-11 — 创建工作区 + 说目标 → 自动开岗（前端 + IdP，无 execTemplate）

## Parent

`.scratch/virtual-office/PRD.md`

## What to build

把整个产品 pitch 兑现：**用户只要"创建 workspace + 导入数据 + 写目标"，剩下都不用管**。

### 流程

1. 既有"新建 workspace"对话框新增一栏 "目标"（多行 textarea）。
2. 同时引导（可跳过）"导入数据"——若导入则进入既有 import 流程。
3. 提交后浏览器：
   a. 调 IdP create-workspace（input 含 `workspaceName`, `workspaceSlug`, `goal`）；IdP 内部把 `goal` 透传给后端（webhook 或 IdP 自己存）。
   b. 拿到 NS-admin token → 走 web-frontend-migration issue 06 流程：DEFINE DATABASE + 应用模板 + INSERT owner user。
   c. silent refresh 换"日常 admin token" → enterWorkspace。
   d. 浏览器以 admin access：
      - `INSERT office_role` 三条（manager / analyst / form-officer）。
      - 调后端 `/api/internal/employee-provisioned` 三次（dispatcher 写 employee_credential + 同步缓存）。该 endpoint 内部用 root + admin 协作完成"INSERT user kind=virtual + INSERT employee_credential"。
      - `INSERT office_task { assigner: self, assignee: manager, goal: '<目标>，请规划下一步' }`。
   e. dispatcher LIVE 命中该 task → 自然拉起第一次执行窗口；浏览器办公室页 LIVE 订阅看到员工陆续上岗 + 第一条 message。
4. 前端跳转到办公室页（Web 路由），通过浏览器直连 LIVE 看实时进展。

### Schema 增量

`goal` 字段加在 IdP 端（IdP 保管 workspace 元数据）或 ws db 的某张配置表（待 IdP 选型定）。本 issue 草案放后者：

在 workspace template 增量 `004-tables-vo.surql` 新增 `workspace_meta` 单例表：

```surql
DEFINE TABLE workspace_meta SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR update WHERE $auth.is_admin = true;
DEFINE FIELD goal ON workspace_meta TYPE option<string>;
DEFINE FIELD created_at ON workspace_meta TYPE datetime VALUE time::now();
-- 实际只 CREATE workspace_meta:default 一条记录
```

### 文案

- 对话框副标题："写下你希望这个工作区达成什么。员工会朝这个目标去推进。"
- 创建中 toast："员工正在上岗……"
- 跳转后引导气泡："这是你工作区的办公室。任何更新都会在这里实时出现。"

## Acceptance criteria

- [ ] 创建工作区 + 填目标 + 跳过导入 → 30s 内办公室页面出现 3 个员工 + ≥1 条 office_message。
- [ ] 同上 + 导入 .xlsx → 5 分钟内出现 ≥1 条 `office_report`（项目经理或数据分析师写的）。
- [ ] 不填目标也能创建工作区（保持兼容），只是不自动 seed 员工。
- [ ] 创建失败（DEFINE DATABASE 或 INSERT 失败）→ 浏览器 `REMOVE DATABASE` 回滚 + 通知 IdP 撤销；workspace 不残留。
- [ ] dispatcher 在新员工出现后 ≤30s 内开始处理第一条 task。

## Blocked by

- `.scratch/virtual-office/issues/06-project-manager-role-bundle.md`
- `.scratch/virtual-office/issues/07-data-analyst-role-bundle.md`
- `.scratch/virtual-office/issues/08-form-officer-role-bundle.md`
- `.scratch/virtual-office/issues/09-office-ui-roster-and-activity-stream.md`
- `.scratch/web-frontend-migration/issues/06-create-workspace-flow.md`

## Notes

- 这是产品 hero flow——验收时建议把 demo 录屏归档到 `.scratch/virtual-office/demo/`。
- "调后端 `/api/internal/employee-provisioned`"是因为 `employee_credential` 表 PERMISSIONS NONE，admin 也写不了，必须 root；后端在该 endpoint 内部用 root 写 secret + dispatcher 缓存。
- 创建失败回滚由浏览器主导（已拿 NS-admin token，可 `REMOVE DATABASE`），IdP 端需要"撤销" endpoint 配合。
