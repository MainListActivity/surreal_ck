Status: needs-triage
Label: needs-triage

# VO-03 — 虚拟员工 provisioning endpoint

## Parent

`.scratch/virtual-office/PRD.md`

## What replaced the previous version

前两稿先后是 "员工独立 JWT 签发" 和 "service JWT 配置"，都已被 [`workspace-as-database.md`](../../../docs/adr/workspace-as-database.md) 简化掉。本 issue 改为：

- 提供 admin-only 的 HTTP endpoint：在指定 workspace database 内 INSERT 一条 `kind='virtual'` 的 user 记录 + 写一条 `employee_credential`。
- 后端用 admin 的 JWT 透传执行大部分写入（无需 service JWT），符合"DDL/DML 走用户会话"原则。
- 仅 `employee_credential` 表的写入需要 root（该表对所有 access PERMISSIONS NONE，参见 issue 01）。

## What to build

### HTTP endpoint `POST /api/workspaces/:slug/employees`

入参：

```ts
{ roleKey: string, displayName?: string }
```

处理：

1. 从 Authorization header 取用户 OIDC JWT，verify。
2. 后端查 `_system.workspace` 拿到该 slug 对应的 `db_name`。
3. 用 OIDC JWT 调 `SIGNIN { ac: 'admin', ns: 'main', db: <db_name>, token: <oidc-jwt> }`；若 AUTHENTICATE 抛错（用户不在该 workspace、或非管理员），直接 403——**不需要应用层兜底校验 is_admin**，DB 引擎已保证。
4. 生成 `subject = urn:virtual:<uuid>` + `secret = randomBase64(32)`。
5. 以 admin 会话：`INSERT user { subject, kind: 'virtual', display_name, virtual_profile: { role: office_role:<key>, status: 'active' } }` → `newId`。
6. 以 root 会话（仅本步）：`INSERT employee_credential { employee: newId, secret }`。
7. 返回 `{ employeeId: newId }`。

**为什么 6 必须走 root**：`employee_credential` 表 PERMISSIONS NONE，admin 都看不到；secret 仅作 SIGNIN 校验材料，永不出 DB。本 endpoint 是 root 调用面最小化的实现（只一行 INSERT，无副作用）。

### HTTP endpoint `POST /api/workspaces/:slug/employees/:id/retire`

同样 admin-only：把 `virtual_profile.status` 改为 `'retired'`，dispatcher 下次心跳跳过；可选地把 `employee_credential.secret` 清空以彻底锁死 SIGNIN。

### HTTP endpoint `POST /api/workspaces/:slug/employees/:id/pause` / `/resume`

切换 `virtual_profile.status` 在 `paused` / `active`。

### HTTP endpoint `GET /api/workspaces/:slug/employees`

后端按调用者身份 SIGNIN（admin 或 participant），SELECT user 表（PERMISSIONS 已允许同 ws 用户互相可读）。

## Acceptance criteria

- [ ] admin 调 `POST /api/workspaces/:slug/employees` → user 表多出一条 `kind='virtual'` 记录 + employee_credential 表多出一条
- [ ] 非 admin（participant）调同 endpoint 返回 403：SIGNIN 走 admin access 时 AUTHENTICATE 抛错，后端捕获即拒
- [ ] 跨 workspace 调（用户不属于该 slug 对应的 ws db）返回 403（admin access AUTHENTICATE 找不到 user 记录）
- [ ] retire 后，员工记录 `status='retired'`；employee_credential.secret 被清空（管理员可通过 endpoint 触发，后端走 root 清空）
- [ ] 重新 provision 同名员工不冲突（subject 用 uuid 保证唯一）
- [ ] root 凭证仅在第 6 步（INSERT employee_credential）使用；其余步骤都走 admin 会话

## Blocked by

- `.scratch/virtual-office/issues/01-workspace-template-user-and-role.md`
- web-only-pivot 第一阶段：`server/` 目录、OIDC verify、用户 JWT 透传到 SurrealDB 已就位

## Notes

- **无 service JWT**：架构内不存在该概念。root 仅在第 6 步（INSERT employee_credential）使用——这是 root 调用面最小化的设计。
- 不在本 issue 创建任何 `office_role` 记录；岗位 seed 由 issue 06/07/08 各自带初始数据，本 endpoint 只接受已存在的 `office_role.key`。
- `employee_credential.secret` 是员工的"密码"，永不出 DB。在 DEFINE ACCESS employee 的 SIGNIN query 中校验（详见 [`virtual-office.md`](../../../docs/adr/virtual-office.md) §1）。
- "按身份选 access"的统一登录流程实现见 issue 09 的后端 `/api/sessions` endpoint；本 issue 假设它就绪并复用。
