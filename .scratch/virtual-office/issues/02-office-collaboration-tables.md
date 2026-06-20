Status: needs-triage
Label: needs-triage

# VO-02 — 办公室协作四表（workspace db schema seed）

## Parent

`.scratch/virtual-office/PRD.md`

## What to build

在 `shared/sql/workspace-template/` 的虚拟办公室增量中，加入 4 张 **虚拟办公室** 协作表，全部 SCHEMAFULL + CHANGEFEED 7d。WP-C-06 创建 workspace 与 WP-C-04 迁移既有 workspace 都会应用该增量。

**关键简化**：所有归属判断由 ws db 边界天然提供（参见 [`workspace-as-database.md`](../../../docs/adr/workspace-as-database.md)）；PERMISSIONS 只表达"在本 workspace 内的具体角色约束"，不再有 `workspace IN $auth<-has_workspace_member<-workspace` 这种嵌套。

**写入身份**：

归因字段统一 `DEFAULT fn::current_user()`，调用方不手工传发起人。原因（见 [`009-fn-current-user.surql`](../../../shared/sql/workspace-template/009-fn-current-user.surql)）：

- 虚拟员工走 employee（RECORD）会话，`$auth` = 员工 user，`fn::current_user()` 直接返回 `$auth`。
- 真人派单走 admin（JWT）会话，**`$auth` 为 NONE**——`DEFAULT $auth` 会让必填 `record<user>` 字段写入失败；`fn::current_user()` 从 `$token.sub` 反查 admin 的 user record，正确归因。
- 真人普通成员走 participant（RECORD）会话，同员工，`fn::current_user()` = `$auth`。

各表归因：

- `office_task.assigner`：`DEFAULT fn::current_user()`。PERMISSIONS `FOR create WHERE assigner = $auth` 对 RECORD 会话（员工/participant）由引擎卡死"只能派自己名义的单"；admin JWT 会话绕过 PERMISSIONS，由 `DEFAULT` 保证 assigner 仍是真实管理员。
- `office_message.from` / `office_report.from`：`DEFAULT fn::current_user()`。
- `user_notification.from_employee`：`DEFAULT fn::current_user()`。PERMISSIONS `FOR create WHERE from_employee = $auth AND $auth.kind = 'virtual'`——只有虚拟员工（RECORD 会话且 kind=virtual）能发起。

**关于 `$auth.is_admin` 兜底分支**：PERMISSIONS 子句里的 `OR $auth.is_admin = true` 对 admin JWT 会话恒为 false（admin `$auth` 为 NONE），它对真人 admin 实际不生效——真人 admin 靠 JWT 超级会话**绕过整张表的 PERMISSIONS** 完成兜底 update/delete，不依赖这个条件。保留该分支只是表达"管理员可兜底"的意图，并为未来若改用 RECORD-admin 留口子。

不再有"service-only"PERMISSIONS。

### `office_task`（**派单**）

```surql
DEFINE TABLE office_task SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create WHERE assigner = $auth,
    FOR update WHERE assignee = $auth OR assigner = $auth OR $auth.is_admin = true,
    FOR delete WHERE $auth.is_admin = true;
DEFINE FIELD assigner    ON office_task TYPE record<user> DEFAULT fn::current_user();
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
DEFINE FIELD from        ON office_message TYPE record<user> DEFAULT fn::current_user();
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
DEFINE FIELD from       ON office_report TYPE record<user> DEFAULT fn::current_user();
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
DEFINE FIELD from_employee    ON user_notification TYPE record<user> DEFAULT fn::current_user();
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

- [ ] WP-C-06 创建 workspace 后，四张表 schema 全部就位
- [ ] 归因 DEFAULT 单测：四张表的发起人字段都是 `DEFAULT fn::current_user()`（不手工传），INSERT 后归因字段 = 当前会话身份
- [ ] PERMISSIONS 单测（按会话类型分别验，因为 admin JWT 绕过 PERMISSIONS）：
  - **RECORD 会话**（participant / employee）INSERT `office_task` 时省略 assigner → `DEFAULT fn::current_user()` 填为 `$auth`；尝试传 `assigner=别人` → `FOR create WHERE assigner = $auth` 被引擎拒
  - 虚拟员工以 employee access SIGNIN 后，能 INSERT `office_message`（from 自动 = self）+ `user_notification`（from_employee 自动 = self，`$auth.kind='virtual'` 通过）
  - 真人 **participant**（is_admin=false 的 RECORD 会话）INSERT `user_notification` 被拒（`$auth.kind = 'human'` 不满足 `= 'virtual'`）
  - **admin JWT 会话** INSERT `office_task` 不受 `assigner = $auth` 约束（超级会话绕过 PERMISSIONS），但 assigner 仍由 `DEFAULT fn::current_user()`（按 `$token.sub` 反查）填为真实管理员，不是 NONE
  - 隔离验证靠 token scope，不靠 AUTHENTICATE 拒绝：跨 workspace 用户的 token 不带该 db 的 admin/participant scope，signin 该 db 失败；**不要**断言"AUTHENTICATE 拒绝跨 ws 用户"（AUTHENTICATE 在用户不存在时反而会建号——隔离不在这一层，在 scope 颁发那一层）
- [ ] LIVE SELECT 烟雾测试：浏览器**直接** `db.live(...)` 订阅 `office_task WHERE assignee = $auth AND status = 'open'`，新建任务时立即收到事件（参见 `docs/adr/frontend-direct-connect.md`）
- [ ] 真人 admin 能在 UI 上 update / delete 任意 office_task（靠 admin JWT 超级会话绕过 PERMISSIONS，而非靠 `OR $auth.is_admin = true` 分支——该分支对 admin `$auth=NONE` 恒 false）

## Blocked by

- `.scratch/virtual-office/issues/01-workspace-template-user-and-role.md`
- `shared/sql/workspace-template/009-fn-current-user.surql`（已落地）——四张表的归因 `DEFAULT fn::current_user()` 依赖该函数已定义

## Notes

- 消息表 update/delete 全锁死：审计要求。
- `office_task.depth` 由调用方维护，PERMISSIONS 不强校验——这是 issue 05 的死循环防御职责。
- 不在本 issue 实现 `seen_at` / `read_state`；issue 09 在 UI 层做未读计算。
- **归因模型**：相比前一稿，去掉 `service-only`；归因走 `DEFAULT fn::current_user()`。对 RECORD 会话（员工/participant）由 PERMISSIONS `WHERE 归因字段 = $auth` 引擎强制；对 admin JWT 会话则靠 `DEFAULT` 填正确发起人（admin 绕过 PERMISSIONS，引擎不强制）。**"写入归因由 engine 保证"只对 RECORD 会话成立**，admin 路径靠 DEFAULT + 应用层不暴露越权写口。
- VO 增量在 template 里的版本号需排在 009 之后（≥ 010），保证函数先定义；具体版本号建增量时按 `index.ts` manifest 末尾顺延。
