Status: needs-triage
Label: needs-triage

# VO-11 — 创建工作区 + 说目标 → 自动开岗

## Parent

`.scratch/virtual-office/PRD.md`

## What to build

把整个产品 pitch 兑现：**用户只要"创建 workspace + 导入数据 + 写目标"，剩下都不用管**。

### 流程

1. 既有"新建 workspace"对话框新增一栏 "目标"（多行 textarea）
2. 同时引导（可跳过）"导入数据"——若导入则进入既有 import 流程
3. 提交后前端调一个聚合 endpoint `POST /api/workspaces/with-office`：
   - 后端用 root 凭证调 `create_workspace` execTemplate，建新 ws db + seed schema + 把调用者作为首个 admin user 写入 + 在 `_system.workspace` 写索引（含 `goal` 字段）
   - 后端切换到调用者 JWT，SIGNIN 到新 ws db；以 admin 身份：
     - INSERT `office_role` 三条（manager / analyst / form-officer）
     - 调三次内部员工 provisioning（复用 issue 03 的核心逻辑，不走 HTTP）：每次 INSERT 一条 user + employee_credential
     - INSERT 第一条 `office_task { assigner: self (admin), assignee: manager, goal: 'workspace 目标如下：<goal>。请规划下一步。' }`
   - dispatcher 在下一次启动或下一个心跳/LIVE 命中时把这三个员工纳入管理（或者后端在 endpoint 末尾调一个内部 `dispatcher.refreshWorkspace(slug)`）
4. 前端跳转到办公室页（Web 路由），通过后端 WS LIVE 转发让用户看到员工陆续上岗、第一条 message 写出

### Schema 增量

在 `_system` db 的 `workspace` 索引表上：

```surql
DEFINE FIELD IF NOT EXISTS goal ON TABLE workspace TYPE option<string>;
```

### 文案

- 对话框副标题："写下你希望这个工作区达成什么。员工会朝这个目标去推进。"
- 创建中 toast："员工正在上岗……"
- 跳转后引导气泡："这是你工作区的办公室。任何更新都会在这里实时出现。"

## Acceptance criteria

- [ ] 创建工作区 + 填目标 + 跳过导入 → 30s 内办公室页面出现 3 个员工 + ≥1 条 office_message
- [ ] 同上 + 导入 .xlsx → 5 分钟内出现 ≥1 条 `office_report`（项目经理或数据分析师写的）
- [ ] 不填目标也能创建工作区（保持兼容），只是不自动 seed 员工
- [ ] 创建失败（任一员工签发失败）时整体回滚：workspace 不留半成品员工记录

## Blocked by

- `.scratch/virtual-office/issues/06-project-manager-role-bundle.md`
- `.scratch/virtual-office/issues/07-data-analyst-role-bundle.md`
- `.scratch/virtual-office/issues/08-form-officer-role-bundle.md`
- `.scratch/virtual-office/issues/09-office-ui-roster-and-activity-stream.md`

## Notes

- 这是产品 hero flow——验收时建议把 demo 录屏作为产物归档到 `.scratch/virtual-office/demo/`。
- 创建失败回滚：聚合 endpoint 在任一员工创建失败时把已创建的员工标 `virtual_profile.status='retired'`、workspace 保留；ws db 本身不删（drop database 是 root 操作，MVP 不暴露）。错误信息一并返回前端供用户重试。
- `dispatcher.refreshWorkspace(slug)` 是 dispatcher 暴露给后端业务代码的内部入口，让"新建 workspace + seed 员工"后立即把这些员工纳入管理；具体实现在 issue 04 范围。
