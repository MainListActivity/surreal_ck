Status: needs-triage
Label: needs-triage

# VO-01 — workspace-template 内 user 表、office_role、employee_credential 与三条 ACCESS

## Parent

`.scratch/virtual-office/PRD.md`

## What to build

在 `create_workspace` execTemplate 的 seed 步骤中，加入：

1. 三条 `DEFINE ACCESS`（`admin` / `participant` / `employee`）。
2. `user` 表完整定义（含 `kind` / `is_admin` / `virtual_profile`）。
3. `office_role` 表完整定义。
4. `employee_credential` 表完整定义（仅 root 可见）。

这些 schema 会随每个新建的 workspace database 一并 seed。

### 1. 三条 ACCESS

详细 SurrealQL 见 [`workspace-as-database.md`](../../../docs/adr/workspace-as-database.md) §1。本 issue 落地三个 access 的完整 DEFINE，必须满足：

- `admin` (TYPE JWT)：AUTHENTICATE 中拒绝 `kind != 'human'` 或 `is_admin != true`。
- `participant` (TYPE RECORD)：SIGNIN 中要求 `kind = 'human' AND is_admin = false`。
- `employee` (TYPE RECORD)：SIGNIN 中校验 `kind='virtual' AND virtual_profile.status='active'` 且 secret 与 `employee_credential.secret` 一致。

### 2. user 表（在每个 ws db 内）

```surql
DEFINE TABLE user SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    -- 同 ws db 任何登录用户都能看花名册
    FOR select WHERE $auth != NONE,
    -- 用户更新自己的常规字段；管理员可改任何人
    FOR update WHERE id = $auth OR $auth.is_admin = true,
    -- 创建只允许管理员
    FOR create WHERE $auth.is_admin = true,
    -- 不允许 delete（用 virtual_profile.status='retired' 软删）
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
DEFINE INDEX user_subject_unique ON user COLUMNS subject UNIQUE;
```

### 3. office_role 表

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

无 `workspace` 字段——本 db 内的所有记录都属于本 workspace。

### 4. employee_credential 表（员工 SIGNIN secret）

**所有 access 都看不到这张表**——只 root 可读。secret 通过 `DEFINE ACCESS employee` 的 SIGNIN query 内部消化（参见 §1）；从 db 外面看不到 secret 是哪条记录。

```surql
DEFINE TABLE employee_credential SCHEMAFULL
  PERMISSIONS NONE;       -- admin / participant / employee 都看不到
DEFINE FIELD employee  ON employee_credential TYPE record<user>;
DEFINE FIELD secret    ON employee_credential TYPE string;
DEFINE FIELD created_at ON employee_credential TYPE datetime VALUE time::now();
DEFINE FIELD rotated_at ON employee_credential TYPE option<datetime>;
DEFINE INDEX employee_credential_unique ON employee_credential COLUMNS employee UNIQUE;
```

但 RECORD access 的 SIGNIN query 是 SurrealQL，**它对表的可见性需要单独确认**：
- 若 SIGNIN 中 SELECT employee_credential 受 PERMISSIONS NONE 阻挡，则把这张表的 select PERMISSIONS 放开给"特殊 system 视角"——具体写法 issue 阶段实测。备选：用 root 内部表（`_credential_*`）或在 SIGNIN 中通过 `$session` 注入 root 上下文。
- 最坏情况退路：把 secret 字段放回 user 表，并对 user 表做字段级 PERMISSIONS（仅 root 可读 secret 字段）。

## Acceptance criteria

- [ ] `create_workspace` execTemplate 在新建 ws db 时，3 条 ACCESS + 3 张表 schema 全部 seed 成功
- [ ] 真人 owner 在新建 workspace 后自动出现于 user 表，`is_admin=true, kind='human'`
- [ ] 管理员（admin access）SIGNIN 成功后，能 `DEFINE TABLE foo SCHEMAFULL` 成功（验证 DDL 自服务）
- [ ] 普通成员（participant access）SIGNIN 成功后，`DEFINE TABLE foo` 被 SurrealDB 引擎直接拒绝（不依赖 PERMISSIONS）
- [ ] 普通成员尝试 INSERT office_role 或 user 被 PERMISSIONS 拒绝
- [ ] 用错的 secret 走 employee access SIGNIN 失败
- [ ] employee_credential 表对三类 access 全部不可见（SELECT 返 0 或 PERMISSIONS 报错）
- [ ] CONTEXT.md 中 **用户** / **虚拟员工** / **工作区管理员** / **普通成员** 四个术语对齐本 issue 的 schema

## Blocked by

- 必须先有 [`workspace-as-database.md`](../../../docs/adr/workspace-as-database.md) 的 `create_workspace` execTemplate 框架（属于 web-only-pivot 阶段，不在本 PRD 范围）

## Notes

- 三条 access 的 SurrealQL 字面值会随 OIDC provider 选定（issue 阶段）回填 JWKS URL。
- 本 issue 不创建任何 `office_role` 记录；岗位 seed 由 issue 06/07/08 各自带初始数据。
- `employee_credential` 拆为独立表的理由：避免在 user 表上做 per-field PERMISSIONS（SurrealDB 支持但显著增加心智复杂度）。
- 真人不需要 `employee_credential` 记录。
- 本 schema 是"workspace 模板"的一部分；任何业务表 schema 升级都要走 schema migration runner（遍历所有 ws db）。
- **db 名约定**：由系统自动生成 `ws_<nanoid12>`（不允许用户输入 slug 进入 db 名）；slug 仅在 `_system.workspace.slug` 字段中作为 URL 展示用。
