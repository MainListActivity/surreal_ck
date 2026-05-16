Status: needs-triage
Label: needs-triage

# VO-02 — 办公室协作四表（workspace db schema seed）

## Parent

`.scratch/virtual-office/PRD.md`

## What to build

在 `create_workspace` execTemplate 的 seed 步骤中，加入 4 张 **虚拟办公室** 协作表，全部 SCHEMAFULL + CHANGEFEED 7d。

**关键简化**：所有归属判断由 ws db 边界天然提供（参见 [`workspace-as-database.md`](../../../docs/adr/workspace-as-database.md)）；PERMISSIONS 只表达"在本 workspace 内的具体角色约束"，不再有 `workspace IN $auth<-has_workspace_member<-workspace` 这种嵌套。

**写入身份**：

- `office_task.create`：`assigner = $auth`，即派单人必须是自己（无论是真人 admin 还是虚拟员工）。
- `office_message.create`：`from = $auth`。真人和虚拟员工都用各自会话身份写。
- `office_report.create`：`from = $auth`。
- `user_notification.create`：`from_employee = $auth AND $auth.kind = 'virtual'`——只有虚拟员工能发起。

不再有"service-only"PERMISSIONS。

### `office_task`（**派单**）

```surql
DEFINE TABLE office_task SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create WHERE assigner = $auth,
    FOR update WHERE assignee = $auth OR assigner = $auth OR $auth.is_admin = true,
    FOR delete WHERE $auth.is_admin = true;
DEFINE FIELD assigner    ON office_task TYPE record<user>;
DEFINE FIELD assignee    ON office_task TYPE record<user>;
DEFINE FIELD goal        ON office_task TYPE string;
DEFINE FIELD parent_task ON office_task TYPE option<record<office_task>>;
DEFINE FIELD depth       ON office_task TYPE int DEFAULT 0;
DEFINE FIELD status      ON office_task TYPE string
  ASSERT $value INSIDE ['open', 'in_progress', 'blocked', 'done', 'stalled', 'cancelled'];
DEFINE FIELD due_at      ON office_task TYPE option<datetime>;
DEFINE FIELD result      ON office_task TYPE option<string>;
DEFINE FIELD created_at  ON office_task TYPE datetime VALUE time::now();
DEFINE FIELD updated_at  ON office_task TYPE datetime VALUE time::now();
DEFINE INDEX office_task_assignee_open ON office_task COLUMNS assignee, status;
```

### `office_message`

```surql
DEFINE TABLE office_message SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create WHERE from = $auth,
    FOR update, delete NONE;
DEFINE FIELD from        ON office_message TYPE record<user>;
DEFINE FIELD to          ON office_message TYPE option<record<user>>;
DEFINE FIELD body        ON office_message TYPE string;
DEFINE FIELD in_reply_to ON office_message TYPE option<record<office_message>>;
DEFINE FIELD mentions    ON office_message TYPE array<record<user>>;
DEFINE FIELD created_at  ON office_message TYPE datetime VALUE time::now();
DEFINE INDEX office_message_created ON office_message COLUMNS created_at;
DEFINE INDEX office_message_to_unread ON office_message COLUMNS to, created_at;
```

### `office_report`

```surql
DEFINE TABLE office_report SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create WHERE from = $auth,
    FOR update, delete NONE;
DEFINE FIELD from       ON office_report TYPE record<user>;
DEFINE FIELD to         ON office_report TYPE record<user>;
DEFINE FIELD task       ON office_report TYPE option<record<office_task>>;
DEFINE FIELD summary    ON office_report TYPE string;
DEFINE FIELD next_steps ON office_report TYPE option<string>;
DEFINE FIELD blocked_by ON office_report TYPE option<string>;
DEFINE FIELD created_at ON office_report TYPE datetime VALUE time::now();
DEFINE INDEX office_report_to_recent ON office_report COLUMNS to, created_at;
```

### `user_notification`

```surql
DEFINE TABLE user_notification SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE to_user = $auth OR $auth.is_admin = true,
    FOR create WHERE from_employee = $auth AND $auth.kind = 'virtual',
    FOR update WHERE to_user = $auth OR $auth.is_admin = true,
    FOR delete NONE;
DEFINE FIELD from_employee    ON user_notification TYPE record<user>;
DEFINE FIELD to_user          ON user_notification TYPE record<user>;
DEFINE FIELD severity         ON user_notification TYPE string
  ASSERT $value INSIDE ['info', 'action_required', 'urgent'];
DEFINE FIELD body             ON user_notification TYPE string;
DEFINE FIELD requested_action ON user_notification TYPE option<string>;
DEFINE FIELD resolution       ON user_notification TYPE option<string>;
DEFINE FIELD resolved_at      ON user_notification TYPE option<datetime>;
DEFINE FIELD created_at       ON user_notification TYPE datetime VALUE time::now();
DEFINE INDEX user_notification_to_open ON user_notification COLUMNS to_user, resolved_at;
```

## Acceptance criteria

- [ ] `create_workspace` execTemplate 落库后，四张表 schema 全部就位
- [ ] PERMISSIONS 单测：
  - 真人 admin 能 INSERT `office_task { assigner: self }`，但不能 INSERT `assigner=别人`
  - 虚拟员工以 employee access SIGNIN 后，能 INSERT `office_message { from: self }` + `user_notification { from_employee: self }`
  - 真人（无论 is_admin）不能 INSERT `user_notification`（因为 `$auth.kind = 'human'`）
  - 非该 ws db 的 user（即跨 workspace 的用户）连这个 db 都 SIGNIN 失败（access AUTHENTICATE 拒绝），自然看不到任何记录
- [ ] LIVE SELECT 烟雾测试：浏览器（通过后端 WS 转发）能订阅 `LIVE SELECT * FROM office_task WHERE assignee = $auth AND status = 'open'`，新建任务时立即收到事件
- [ ] 真人 admin 能在 UI 上 update / delete 任意 office_task（兜底）

## Blocked by

- `.scratch/virtual-office/issues/01-workspace-template-user-and-role.md`

## Notes

- 消息表 update/delete 全锁死：审计要求。
- `office_task.depth` 由调用方维护，PERMISSIONS 不强校验——这是 issue 05 的死循环防御职责。
- 不在本 issue 实现 `seen_at` / `read_state`；issue 09 在 UI 层做未读计算。
- **PERMISSIONS 变化**：相比前一稿，去掉了 `service-only` 模式；写入归因走 `$auth`，由 SurrealDB engine 保证。
