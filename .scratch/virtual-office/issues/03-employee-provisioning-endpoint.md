Status: needs-triage
Label: needs-triage

# VO-03 — 虚拟员工 provisioning endpoint

## Parent

`.scratch/virtual-office/PRD.md`

## What replaced the previous version

前两稿先后是 "员工独立 JWT 签发" 和 "service JWT 配置"，都已被 [`workspace-as-database.md`](../../../docs/adr/workspace-as-database.md) 简化掉。本 issue 改为：

- 提供 admin-only 的 HTTP endpoint：在指定 workspace database 内 INSERT 一条 `kind='virtual'` 的 user 记录 + 写一条 `employee_credential`。
- 后端用调用者的 OIDC JWT 以 admin access 透传执行 user 表写入。admin 是 `TYPE JWT` access——它是 DB 级超级会话，能读写任何表、执行任何 DDL、`$auth` 为 NONE 且**不受 record-level PERMISSIONS 约束**，所以 INSERT user（即便 user 表 `FOR create WHERE $auth.is_admin=true`）也能成功。
- **授权关卡 = 能不能 signin 该 db 的 admin access**：admin 级 token 的颁发被卡在 IdP 认证阶段——IdP 颁发 token 前调后端的用户身份接口，后端按**该 workspace db 内** `user.is_admin` 决定是否给这个 db 颁发 admin scope（per-workspace 粒度，见 `server/src/workspaces/workspace-scope.ts` getDefaultScope）。所以：
  - 非管理员的 token 对该 db **没有 admin scope** → `SIGNIN { ac:'admin', db }` 直接失败 → 403。
  - 跨 workspace（调用者对该 slug 的 db 无 admin 身份）同理：token 不含该 db 的 admin scope → signin 失败 → 403。
  - **"signin admin 成功"即等价于"调用者是该 workspace 的管理员"**，无需再在应用层查 is_admin。（与旧稿的差异：旧稿说靠 AUTHENTICATE 抛错判权限，那是错的——真正的关卡是 token 是否带该 db 的 admin scope，由 IdP 颁发阶段决定。）
- 仅 `employee_credential` 表的写入和 `_system.workspace` 索引读取需要 root；前者因为 PERMISSIONS NONE，后者因为 _system 无 access。
- secret 同步装入 dispatcher 进程内缓存，供后续 SIGNIN 复用；不再从 DB 反复读取。

## What to build

### HTTP endpoint `POST /api/workspaces/:slug/employees`

入参：

```ts
{ roleKey: string, displayName?: string }
```

处理：

1. 从 Authorization header 取用户 OIDC JWT，verify（jose + JWKS）。
2. 后端用 root 查 `_system.workspace WHERE slug = ?` 拿到 `db_name`。
3. 用 OIDC JWT 调 `SIGNIN { ac: 'admin', ns: 'main', db: <db_name>, token: <oidc-jwt> }`。**signin 失败即 403**——失败意味着该 token 不带该 db 的 admin scope，即调用者不是该 workspace 的管理员（或根本不属于该 workspace）。这就是授权关卡，不需要再查 is_admin。
4. 生成 `subject = urn:virtual:<uuid>` + `secret = randomBase64(32)`。
5. 以 admin 会话：`INSERT user { subject, kind: 'virtual', display_name, virtual_profile: { role: office_role:<key>, status: 'active' } }` → `newId`（admin 绕过 user 表 PERMISSIONS，写入成功）。
6. 以 root 会话（仅本步）：`INSERT employee_credential { employee: newId, secret }`。
7. 把 secret 加进 dispatcher 进程内缓存（键：`<db_name>:<newId>`），dispatcher 后续 SIGNIN 直接读缓存（详见 [`virtual-office.md`](../../../docs/adr/virtual-office.md) §1 SIGNIN 流程）。
8. 返回 `{ employeeId: newId }`。

**为什么 6 必须走 root**：`employee_credential` 表 PERMISSIONS NONE，连 admin 超级会话也写不了（NONE 对所有身份关闭，root 是系统用户不过 PERMISSIONS）。secret 仅作 SIGNIN 校验材料，永不出 DB。

**为什么授权靠 signin 成败就够**：admin 级 token 的颁发被 IdP 认证阶段卡死——IdP 信任后端返回的"该 db 内 user.is_admin"来决定是否给该 db 颁发 admin scope（per-workspace 粒度）。非管理员 / 跨 workspace 用户拿到的 token 不含该 db 的 admin scope，signin admin 直接失败。所以 signin 成功 ⟺ 是该 workspace 管理员，无需应用层兜底查 is_admin。

**为什么 SIGNIN 时不会再次需要读 secret**：dispatcher 在进程内缓存了所有员工的 secret（启动时 + 本 endpoint 写入时同步装入），SIGNIN 直接提供 secret 给 SurrealDB 内部 SIGNIN query 校验——SIGNIN query 自身能读 PERMISSIONS NONE 表完成比对。

### HTTP endpoint `POST /api/workspaces/:slug/employees/:id/retire`

同样 admin-only（授权同 POST：signin 该 db 的 admin access，失败即 403）：

1. signin admin（失败 → 403）
2. admin 会话 UPDATE `user.virtual_profile.status = 'retired'`
3. root 会话 UPDATE `employee_credential SET secret = '__retired_' + rand::uuid() WHERE employee = :id`（清空 secret 等于换密码，已签发的 1h token 到期后无法续约；当前进行中的 token 不主动 revoke，MVP 接受这一延迟）
4. 从 dispatcher 进程内缓存中移除该员工的 secret + 关闭对应 LIVE 连接

### HTTP endpoint `POST /api/workspaces/:slug/employees/:id/pause` / `/resume`

切换 `virtual_profile.status` 在 `paused` / `active`。同样走第 4 步的管理员判定。

### HTTP endpoint `GET /api/workspaces/:slug/employees`

后端用调用者 OIDC JWT 以 **participant** access SIGNIN（RECORD 会话，`$auth` = 调用者 user record），SELECT user 表——user 表 `FOR select WHERE $auth != NONE` 允许同 ws 任意登录用户互相可读，participant 会话受此约束、跨 ws 用户因建不出本 db 的 user 记录而被天然隔离。这里**刻意用 participant 而非 admin**：读取场景不需要超级会话，participant 让 PERMISSIONS 兜底，避免 admin 绕过隔离。

## Acceptance criteria

- [ ] 工作区管理员调 `POST /api/workspaces/:slug/employees` → user 表多出一条 `kind='virtual'` 记录 + employee_credential 表多出一条 + dispatcher 缓存装入 secret
- [ ] 非管理员（is_admin=false 的成员）调同 endpoint 返回 403：其 token 对该 db 只有 participant scope、无 admin scope，`SIGNIN { ac:'admin' }` 失败
- [ ] 跨 workspace 调（用户不属于该 slug 对应的 ws db）返回 403：token 不含该 db 的 admin scope，signin 失败
- [ ] retire 后：`status='retired'` + secret 被改成无意义值 + dispatcher 缓存移除 + 对应 LIVE 连接关闭
- [ ] 重新 provision 同名员工不冲突（subject 用 uuid 保证唯一）
- [ ] root 凭证仅在第 6 步（INSERT employee_credential）和第 2 步（_system 查 workspace 索引）使用；其余步骤都走 admin / participant 会话

## Blocked by

- `.scratch/virtual-office/issues/01-workspace-template-user-and-role.md`
- web-only-pivot 第一阶段：`server/` 目录、OIDC verify、用户 JWT 透传到 SurrealDB 已就位

## Notes

- **无 service JWT**：架构内不存在该概念。root 仅在第 6 步（INSERT employee_credential）使用——这是 root 调用面最小化的设计。
- **管理员授权靠"能否 signin 该 db 的 admin access"**：admin 级 token 的颁发被 IdP 认证阶段卡死（IdP 信任后端按该 db `user.is_admin` 给出的 scope，per-workspace 粒度，见 `server/src/workspaces/workspace-scope.ts`）。所以授权关卡前移到 token 颁发，endpoint 只需 signin admin，失败即 403——不需要应用层查 is_admin、也不依赖 record-level PERMISSIONS（admin 超级会话本就绕过 PERMISSIONS）。
- 不在本 issue 创建任何 `office_role` 记录；岗位 seed 由 issue 06/07/08 各自带初始数据，本 endpoint 只接受已存在的 `office_role.key`。
- `employee_credential.secret` 是员工的"密码"，永不出 DB。在 DEFINE ACCESS employee 的 SIGNIN query 中校验（详见 [`virtual-office.md`](../../../docs/adr/virtual-office.md) §1）。
- "按 token scope / slug 解析 workspace" 的能力复用 Workspace Scope Module；本 issue 不重新实现 workspace lookup。
