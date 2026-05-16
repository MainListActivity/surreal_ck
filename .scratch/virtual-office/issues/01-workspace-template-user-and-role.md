Status: needs-triage
Label: needs-triage

# VO-01 — workspace-template 内 user / 邀请 / office_role / employee_credential 与三条 ACCESS；_system 倒查表

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
DEFINE FIELD subject       ON user_workspace_index TYPE string;
DEFINE FIELD workspace     ON user_workspace_index TYPE record<workspace>;
DEFINE FIELD role          ON user_workspace_index TYPE string
  ASSERT $value INSIDE ['admin', 'participant'];
DEFINE FIELD joined_at     ON user_workspace_index TYPE datetime VALUE time::now();
DEFINE FIELD last_seen_at  ON user_workspace_index TYPE option<datetime>;
DEFINE INDEX uwi_subject     ON user_workspace_index COLUMNS subject;
DEFINE INDEX uwi_unique      ON user_workspace_index COLUMNS subject, workspace UNIQUE;
```

### B. Workspace database 模板 schema（每次 create_workspace execTemplate 全量 seed）

#### B.1 三条 ACCESS

完整 SurrealQL 在 [`workspace-as-database.md`](../../../docs/adr/workspace-as-database.md) §1。本 issue 必须落地：

- `DEFINE ACCESS admin ON DATABASE TYPE JWT URL <oidc-jwks>` + AUTHENTICATE 拒非 admin
- `DEFINE ACCESS participant ON DATABASE TYPE RECORD WITH JWT URL <oidc-jwks>` + AUTHENTICATE 校验 aud/sub、首次自动 `CREATE user` 兜底
- `DEFINE ACCESS employee ON DATABASE TYPE RECORD SIGNIN { ... }` + secret 校验内联 SELECT employee_credential

JWKS URL 草稿用 `https://o.maplayer.top/t/ck/jwks.json`（与正在实测的一致），正式上线前回填。

#### B.2 `user` 表

```surql
DEFINE TABLE user SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR update WHERE id = $auth OR $auth.is_admin = true,
    FOR create WHERE $auth.is_admin = true OR $auth = NONE,   -- 留 NONE 给 participant AUTHENTICATE 内自动建用
    FOR delete NONE;

DEFINE FIELD subject       ON user TYPE string;        -- 真人：OIDC sub；虚拟员工：urn:virtual:<uuid>
DEFINE FIELD kind          ON user TYPE string DEFAULT 'human'
  ASSERT $value INSIDE ['human', 'virtual'];
DEFINE FIELD is_admin      ON user TYPE bool DEFAULT false;
DEFINE FIELD display_name  ON user TYPE option<string>;
DEFINE FIELD email         ON user TYPE option<string>;
DEFINE FIELD avatar        ON user TYPE option<string>;
DEFINE FIELD virtual_profile               ON user TYPE option<object>;
DEFINE FIELD virtual_profile.role          ON user TYPE option<record<office_role>>;
DEFINE FIELD virtual_profile.supervisor    ON user TYPE option<record<user>>;
DEFINE FIELD virtual_profile.status        ON user TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ['active', 'paused', 'retired'];
DEFINE FIELD virtual_profile.last_active_at ON user TYPE option<datetime>;
DEFINE FIELD created_at    ON user TYPE datetime VALUE time::now();
DEFINE FIELD updated_at    ON user TYPE datetime VALUE time::now();
DEFINE INDEX user_subject_unique ON user COLUMNS subject UNIQUE;
```

**关键**：`create` PERMISSIONS 中加 `$auth = NONE`，让 participant access 在 AUTHENTICATE 内的兜底 CREATE 能跑过——此时还没建立 user record id，`$auth` 是 NONE。

#### B.3 `pending_workspace_member` 表（管理员发出的待认领邀请）

```surql
DEFINE TABLE pending_workspace_member SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth.is_admin = true OR email = $auth.email,
    FOR create, update, delete WHERE $auth.is_admin = true;
DEFINE FIELD email      ON pending_workspace_member TYPE string ASSERT string::is_email($value);
DEFINE FIELD role       ON pending_workspace_member TYPE string
  ASSERT $value INSIDE ['admin', 'participant'];
DEFINE FIELD invited_at ON pending_workspace_member TYPE datetime VALUE time::now();
DEFINE FIELD invited_by ON pending_workspace_member TYPE option<record<user>>;
DEFINE INDEX pending_email_unique ON pending_workspace_member COLUMNS email UNIQUE;
```

#### B.4 `has_workspace_member` 表（已认领成员关系）

```surql
DEFINE TABLE workspace_singleton SCHEMAFULL;  -- 用于做 RELATE 的"出端"占位
DEFINE FIELD created_at ON workspace_singleton TYPE datetime VALUE time::now();
-- execTemplate seed 时 CREATE workspace_singleton:default;

DEFINE TABLE has_workspace_member TYPE RELATION
  IN workspace_singleton OUT user SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create, update, delete WHERE $auth.is_admin = true OR $auth = NONE;  -- NONE 给认领闭环用 root
DEFINE FIELD role      ON has_workspace_member TYPE string
  ASSERT $value INSIDE ['admin', 'participant'];
DEFINE FIELD joined_at ON has_workspace_member TYPE datetime VALUE time::now();
DEFINE INDEX hwm_unique ON has_workspace_member COLUMNS in, out UNIQUE;
```

**为什么需要 has_workspace_member 边**：邀请认领后留痕；admin endpoint 上"踢人"也是删这条边而不是删 user 记录（virtual_profile.status='retired' 是单独的软删）。

#### B.5 `office_role` 表

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

#### B.6 `employee_credential` 表

```surql
DEFINE TABLE employee_credential SCHEMAFULL
  PERMISSIONS NONE;       -- 所有 access 都看不到；仅 root + SIGNIN 内 SELECT 可读
DEFINE FIELD employee   ON employee_credential TYPE record<user>;
DEFINE FIELD secret     ON employee_credential TYPE string;
DEFINE FIELD created_at ON employee_credential TYPE datetime VALUE time::now();
DEFINE FIELD rotated_at ON employee_credential TYPE option<datetime>;
DEFINE INDEX employee_credential_unique ON employee_credential COLUMNS employee UNIQUE;
```

**SIGNIN 内可读已通过实测验证**——SIGNIN 是 db 级特权脚本，绕过 PERMISSIONS NONE。前一稿"最坏退路"作废。

## Acceptance criteria

- [ ] 在干净 ns/db 上初始化 _system 后，`workspace` 与 `user_workspace_index` 两张表落地；无 access 暴露给真人
- [ ] `create_workspace` execTemplate 在新建 ws db 时：3 条 ACCESS + 6 张业务表（user / pending_workspace_member / has_workspace_member / office_role / employee_credential / workspace_singleton）全部 seed 成功
- [ ] 真人 owner 在新建 workspace 后自动出现于 user 表，`is_admin=true, kind='human'`；_system.user_workspace_index 自动多一行 `{ subject, role: 'admin' }`
- [ ] 管理员（admin access）SIGNIN 成功后，能 `DEFINE TABLE foo SCHEMAFULL` 成功（验证 DDL 自服务）
- [ ] 普通成员（participant access）SIGNIN：
  - 首次成功 → user 表多一条 `kind='human', is_admin=false` 记录
  - `DEFINE TABLE foo` 被 SurrealDB 引擎直接拒绝（不依赖 PERMISSIONS）
  - INSERT office_role 被 PERMISSIONS 拒绝
- [ ] 用错的 secret 走 employee access SIGNIN 失败
- [ ] 用对的 secret 走 employee access SIGNIN 成功，会话内 SELECT employee_credential 仍然为空（PERMISSIONS NONE 对 RECORD access 生效）
- [ ] CONTEXT.md 中 **用户** / **虚拟员工** / **工作区管理员** / **普通成员** 四个术语对齐本 issue 的 schema

## Blocked by

- 必须先有 [`workspace-as-database.md`](../../../docs/adr/workspace-as-database.md) 的 `create_workspace` execTemplate 框架（属于 web-only-pivot 阶段，不在本 PRD 范围）

## Notes

- 三条 access 的 SurrealQL 字面值会随 OIDC provider 选定（issue 阶段）回填 JWKS URL；当前草稿用 `https://o.maplayer.top/t/ck/jwks.json`。
- 本 issue 不创建任何 `office_role` 记录；岗位 seed 由 issue 06/07/08 各自带初始数据。
- `employee_credential` 拆为独立表的理由：避免在 user 表上做 per-field PERMISSIONS（SurrealDB 支持但显著增加心智复杂度）。
- 真人不需要 `employee_credential` 记录。
- 本 schema 是"workspace 模板"的一部分；任何业务表 schema 升级都要走 schema migration runner（遍历所有 ws db）。
- **db 名约定**：由系统自动生成 `ws_<nanoid12>`（不允许用户输入 slug 进入 db 名）；slug 仅在 `_system.workspace.slug` 字段中作为 URL 展示用。
- **邀请认领闭环**：管理员 INSERT pending → 被邀请人首次 participant SIGNIN（自动建 user）→ 后端 endpoint 在认领闭环里 RELATE has_workspace_member + DELETE pending + 写 _system.user_workspace_index（详见 issue 09 §sessions endpoint）。
