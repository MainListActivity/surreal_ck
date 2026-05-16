Status: needs-triage
Label: needs-triage

# VO-03 — 虚拟员工 provisioning endpoint

## Parent

`.scratch/virtual-office/PRD.md`

## What replaced the previous version

前两稿先后是 "员工独立 JWT 签发" 和 "service JWT 配置"，都已被 [`workspace-as-database.md`](../../../docs/adr/workspace-as-database.md) 简化掉。本 issue 改为：

- 提供 admin-only 的 HTTP endpoint：在指定 workspace database 内 INSERT 一条 `kind='virtual'` 的 user 记录 + 写一条 `employee_credential`。
- 后端用 admin 的 OIDC JWT 透传执行 user 表写入（符合"DDL/DML 走用户会话"原则）。
- 仅 `employee_credential` 表的写入和 `_system.workspace` 索引读取需要 root；前者因为 PERMISSIONS NONE，后者因为 _system 无 access。
- secret 同步装入 dispatcher 进程内缓存，供后续 SIGNIN 复用；不再从 DB 反复读取。

## What to build

### HTTP endpoint `POST /api/workspaces/:slug/employees`

入参：

```ts
{ roleKey: string, displayName?: string }
```

处理：

1. 从 Authorization header 取用户 OIDC JWT，verify。
2. 后端用 root 查 `_system.workspace WHERE slug = ?` 拿到 `db_name`。
3. 用 OIDC JWT 调 `SIGNIN { ac: 'admin', ns: 'main', db: <db_name>, token: <oidc-jwt> }`；若 AUTHENTICATE 抛错（用户不在该 workspace、或非管理员），直接 403——**不需要应用层兜底校验 is_admin**，DB 引擎已保证。
4. 生成 `subject = urn:virtual:<uuid>` + `secret = randomBase64(32)`。
5. 以 admin 会话：`INSERT user { subject, kind: 'virtual', display_name, virtual_profile: { role: office_role:<key>, status: 'active' } }` → `newId`。
6. 以 root 会话（仅本步）：`INSERT employee_credential { employee: newId, secret }`。
7. 把 secret 加进 dispatcher 进程内缓存（键：`<db_name>:<newId>`），dispatcher 后续 SIGNIN 直接读缓存（详见 [`virtual-office.md`](../../../docs/adr/virtual-office.md) §1 SIGNIN 流程）。
8. 返回 `{ employeeId: newId }`。

**为什么 6 必须走 root**：`employee_credential` 表 PERMISSIONS NONE，admin 也写不了。secret 仅作 SIGNIN 校验材料，永不出 DB。

**为什么 SIGNIN 时不会再次需要读 secret**：dispatcher 在进程内缓存了所有员工的 secret（启动时 + 本 endpoint 写入时同步装入），SIGNIN 直接提供 secret 给 SurrealDB 内部 SIGNIN query 校验——SIGNIN query 自身能读 PERMISSIONS NONE 表完成比对。

### HTTP endpoint `POST /api/workspaces/:slug/employees/:id/retire`

同样 admin-only：

1. admin SIGNIN 校验身份
2. admin 会话 UPDATE `user.virtual_profile.status = 'retired'`
3. root 会话 UPDATE `employee_credential SET secret = '__retired_' + rand::uuid() WHERE employee = :id`（清空 secret 等于换密码，已签发的 1h token 到期后无法续约；当前进行中的 token 不主动 revoke，MVP 接受这一延迟）
4. 从 dispatcher 进程内缓存中移除该员工的 secret + 关闭对应 LIVE 连接

### HTTP endpoint `POST /api/workspaces/:slug/employees/:id/pause` / `/resume`

切换 `virtual_profile.status` 在 `paused` / `active`。

### HTTP endpoint `GET /api/workspaces/:slug/employees`

后端按调用者身份 SIGNIN（admin 或 participant），SELECT user 表（PERMISSIONS 已允许同 ws 用户互相可读）。

## Acceptance criteria

- [ ] admin 调 `POST /api/workspaces/:slug/employees` → user 表多出一条 `kind='virtual'` 记录 + employee_credential 表多出一条 + dispatcher 缓存装入 secret
- [ ] 非 admin（participant）调同 endpoint 返回 403：SIGNIN 走 admin access 时 AUTHENTICATE 抛错，后端捕获即拒
- [ ] 跨 workspace 调（用户不属于该 slug 对应的 ws db）返回 403（admin access AUTHENTICATE 找不到 user 记录）
- [ ] retire 后：`status='retired'` + secret 被改成无意义值 + dispatcher 缓存移除 + 对应 LIVE 连接关闭
- [ ] 重新 provision 同名员工不冲突（subject 用 uuid 保证唯一）
- [ ] root 凭证仅在第 6 步（INSERT employee_credential）和第 2 步（_system 查 workspace 索引）使用；其余步骤都走 admin 会话

## Blocked by

- `.scratch/virtual-office/issues/01-workspace-template-user-and-role.md`
- web-only-pivot 第一阶段：`server/` 目录、OIDC verify、用户 JWT 透传到 SurrealDB 已就位

## Notes

- **无 service JWT**：架构内不存在该概念。root 仅在第 6 步（INSERT employee_credential）使用——这是 root 调用面最小化的设计。
- 不在本 issue 创建任何 `office_role` 记录；岗位 seed 由 issue 06/07/08 各自带初始数据，本 endpoint 只接受已存在的 `office_role.key`。
- `employee_credential.secret` 是员工的"密码"，永不出 DB。在 DEFINE ACCESS employee 的 SIGNIN query 中校验（详见 [`virtual-office.md`](../../../docs/adr/virtual-office.md) §1）。
- "按身份选 access"的统一登录流程实现见 issue 09 的后端 `/api/sessions` endpoint；本 issue 假设它就绪并复用。
