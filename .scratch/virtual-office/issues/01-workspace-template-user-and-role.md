Status: needs-triage
Label: needs-triage

# VO-01 — workspace-template 内 user / office_role / employee_credential 与三条 ACCESS；_system 倒查表

## Parent

`.scratch/virtual-office/PRD.md`

## What to build

两部分：

### A. `_system` database schema（一次性 seed）

由 web-only-pivot 阶段的"初始化 SurrealDB"步骤创建一次。**无 access** —— 仅 root 凭证可访问。

```surql
USE NS main DB _system;

DEFINE TABLE workspace SCHEMAFULL;
DEFINE FIELD db_name        ON workspace TYPE string;
DEFINE FIELD slug           ON workspace TYPE string;
DEFINE FIELD name           ON workspace TYPE string;
DEFINE FIELD owner_subject  ON workspace TYPE string;
DEFINE FIELD created_at     ON workspace TYPE datetime VALUE time::now();
DEFINE INDEX workspace_db_name_unique ON workspace COLUMNS db_name UNIQUE;
DEFINE INDEX workspace_slug_unique    ON workspace COLUMNS slug UNIQUE;

DEFINE TABLE user_workspace_index SCHEMAFULL;
DEFINE FIELD email         ON user_workspace_index TYPE string;
DEFINE FIELD subject       ON user_workspace_index TYPE option<string>;
DEFINE FIELD workspace     ON user_workspace_index TYPE record<workspace>;
DEFINE FIELD role          ON user_workspace_index TYPE string
  ASSERT $value INSIDE ['admin', 'participant'];
DEFINE FIELD joined_at     ON user_workspace_index TYPE datetime VALUE time::now();
DEFINE INDEX uwi_email          ON user_workspace_index COLUMNS email;
DEFINE INDEX uwi_subject        ON user_workspace_index COLUMNS subject;
DEFINE INDEX uwi_email_ws_unique ON user_workspace_index COLUMNS email, workspace UNIQUE;
```

### B. Workspace database 模板 schema（每次 create_workspace execTemplate 全量 seed）

#### B.1 三条 ACCESS

完整 SurrealQL 在 [`workspace-as-database.md`](../../../docs/adr/workspace-as-database.md) §1。本 issue 必须落地：

- `DEFINE ACCESS admin ON DATABASE TYPE JWT URL <oidc-jwks>` —— AUTHENTICATE 中按 subject 先查、未命中按 email 回填、要求 `is_admin = true`、更新 `last_seen_at`。
- `DEFINE ACCESS participant ON DATABASE TYPE RECORD WITH JWT URL <oidc-jwks>` —— AUTHENTICATE 同上但要求 `is_admin = false`。**不再自动 CREATE user**——找不到记录就 THROW。
- `DEFINE ACCESS employee ON DATABASE TYPE RECORD SIGNIN { ... }` —— secret 校验内联 SELECT employee_credential。

JWKS URL 草稿用 `https://o.maplayer.top/t/ck/jwks.json`，正式上线前回填。

#### B.2 `user` 表

```surql
DEFINE TABLE user SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR update WHERE id = $auth OR $auth.is_admin = true,
    FOR create WHERE $auth.is_admin = true,
    FOR delete WHERE $auth.is_admin = true;

DEFINE FIELD email         ON user TYPE string;
DEFINE FIELD subject       ON user TYPE option<string>;     -- 真人首次 OIDC 登录时由 AUTHENTICATE 回填；虚拟员工创建时即填
DEFINE FIELD kind          ON user TYPE string DEFAULT 'human'
  ASSERT $value INSIDE ['human', 'virtual'];
DEFINE FIELD is_admin      ON user TYPE bool DEFAULT false;
DEFINE FIELD display_name  ON user TYPE option<string>;
DEFINE FIELD avatar        ON user TYPE option<string>;
DEFINE FIELD last_seen_at  ON user TYPE option<datetime>;   -- NONE 表示"从未登录"
DEFINE FIELD virtual_profile               ON user TYPE option<object>;
DEFINE FIELD virtual_profile.role          ON user TYPE option<record<office_role>>;
DEFINE FIELD virtual_profile.supervisor    ON user TYPE option<record<user>>;
DEFINE FIELD virtual_profile.status        ON user TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ['active', 'paused', 'retired'];
DEFINE FIELD virtual_profile.last_active_at ON user TYPE option<datetime>;
DEFINE FIELD created_at    ON user TYPE datetime VALUE time::now();
DEFINE FIELD updated_at    ON user TYPE datetime VALUE time::now();
DEFINE INDEX user_email_unique   ON user COLUMNS email UNIQUE;
DEFINE INDEX user_subject_unique ON user COLUMNS subject UNIQUE;
```

**变化**：

- `email` 为权威定位锚点（管理员添加成员时填）；UNIQUE 索引。
- `subject` 改 option，首次登录由 AUTHENTICATE 内 `UPDATE $u SET subject = $token.sub` 回填；UNIQUE 索引（None 允许多条但有值时唯一——确认 SurrealDB 支持，issue 阶段实测）。
- `last_seen_at`：NONE 表示从未登录；AUTHENTICATE 内每次 SIGNIN 更新。
- 删除 PERMISSIONS 改为允许 admin（删除已添加成员的合法路径）。
- **不再有** `pending_workspace_member` / `has_workspace_member` / `workspace_singleton`——架构内不存在邀请态。

#### B.3 `office_role` 表

```surql
DEFINE TABLE office_role SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create, update, delete WHERE $auth.is_admin = true;
DEFINE FIELD key                ON office_role TYPE string;
DEFINE FIELD label              ON office_role TYPE string;
DEFINE FIELD system_prompt      ON office_role TYPE string;
DEFINE FIELD tool_bundle_key    ON office_role TYPE string;
DEFINE FIELD heartbeat_interval ON office_role TYPE duration DEFAULT 5m;
DEFINE FIELD daily_token_budget ON office_role TYPE int DEFAULT 200000;
DEFINE FIELD default_supervisor_role ON office_role TYPE option<string>;
DEFINE FIELD created_at         ON office_role TYPE datetime VALUE time::now();
DEFINE INDEX office_role_key_unique ON office_role COLUMNS key UNIQUE;
```

#### B.4 `employee_credential` 表

```surql
DEFINE TABLE employee_credential SCHEMAFULL
  PERMISSIONS NONE;       -- 所有 access 都看不到；仅 root + SIGNIN 内 SELECT 可读
DEFINE FIELD employee   ON employee_credential TYPE record<user>;
DEFINE FIELD secret     ON employee_credential TYPE string;
DEFINE FIELD created_at ON employee_credential TYPE datetime VALUE time::now();
DEFINE FIELD rotated_at ON employee_credential TYPE option<datetime>;
DEFINE INDEX employee_credential_unique ON employee_credential COLUMNS employee UNIQUE;
```

## Acceptance criteria

- [ ] 在干净 ns/db 上初始化 _system 后，`workspace` 与 `user_workspace_index` 两张表落地；无 access 暴露给真人
- [ ] `create_workspace` execTemplate 在新建 ws db 时：3 条 ACCESS + 3 张业务表（user / office_role / employee_credential）全部 seed 成功
- [ ] 真人 owner 在新建 workspace 后自动出现于 user 表，`is_admin=true, kind='human'`，email/subject 都填好；_system.user_workspace_index 多一行
- [ ] 管理员（admin access）SIGNIN：
  - 用真 OIDC token + 已存在的 user → 成功，`last_seen_at` 被更新
  - 用 OIDC token 但 user 表没有对应 email → THROW
- [ ] 普通成员（participant access）SIGNIN：
  - 管理员先 INSERT user `{ email, is_admin: false, subject: NONE, last_seen_at: NONE }`，用户用 OIDC token 登录 → 成功，subject 被回填，last_seen_at 被更新
  - 同一个 OIDC token 第二次登录 → 走 subject 命中路径，成功
  - 不在 user 表的 OIDC token → THROW（不再自动建用户）
  - `DEFINE TABLE foo` 被 SurrealDB 引擎直接拒绝
- [ ] 用错的 secret 走 employee access SIGNIN 失败；用对的成功
- [ ] 从未登录成员的 `last_seen_at` 为 NONE，UI 能据此渲染"从未登录"
- [ ] CONTEXT.md 中 **用户** / **虚拟员工** / **工作区管理员** / **普通成员** 四个术语对齐本 issue 的 schema

## Blocked by

- 必须先有 [`workspace-as-database.md`](../../../docs/adr/workspace-as-database.md) 的 `create_workspace` execTemplate 框架（属于 web-only-pivot 阶段，不在本 PRD 范围）

## Notes

- 三条 access 的 SurrealQL 字面值会随 OIDC provider 选定（issue 阶段）回填 JWKS URL；当前草稿用 `https://o.maplayer.top/t/ck/jwks.json`。
- 本 issue 不创建任何 `office_role` 记录；岗位 seed 由 issue 06/07/08 各自带初始数据。
- `subject UNIQUE` 在 None 值上的行为实测已确认 SurrealDB 支持"多条 None 允许，但有值时唯一"
- 真人不需要 `employee_credential` 记录。
- 本 schema 是"workspace 模板"的一部分；任何业务表 schema 升级都要走 schema migration runner（遍历所有 ws db）。
- **db 名约定**：由系统自动生成 `ws_<nanoid12>`（不允许用户输入 slug 进入 db 名）；slug 仅在 `_system.workspace.slug` 字段中作为 URL 展示用。
- **成员添加路径**：管理员调 `POST /api/workspaces/:slug/members { email, isAdmin?, displayName? }`，详见 issue 09。无邀请闭环。
