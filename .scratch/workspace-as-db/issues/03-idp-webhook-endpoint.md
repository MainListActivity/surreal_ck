Status: needs-triage
Label: needs-triage

# WP-C-03 — IdP webhook endpoints（_system 同步入口）

## Parent

`.scratch/workspace-as-db/PRD.md`

## What replaced the previous version

前一稿的 `create_workspace` execTemplate 与 `POST /api/workspaces` 已废除。workspace 创建由 IdP + 前端 DDL 完成；后端只需要在 IdP 推送同步消息时把 `_system` 索引更新好。

## What to build

```
server/src/routes/internal-webhooks.ts
server/src/middleware/idp-webhook-auth.ts
```

### Auth 中间件

`requireIdpWebhook()`：

- 从 header 取 `X-IdP-Signature`（或类似），用环境变量 `IDP_WEBHOOK_SECRET` 共享密钥 HMAC 校验 body。
- 失败 → 401，绝不暴露 stack。
- 通过 → 继续。

### `POST /api/internal/workspace-created`

入参（IdP 推送）：

```ts
{
  workspaceId: string,    // IdP 内 workspace id
  dbName: string,         // ws_<nanoid12>
  slug: string,
  name: string,
  ownerSubject: string,
  ownerEmail: string,
}
```

处理（root 会话）：

1. `INSERT _system.workspace CONTENT { db_name, slug, name, owner_subject, created_at: time::now() }`。
2. `INSERT _system.user_workspace_index CONTENT { subject: ownerSubject, email: ownerEmail, workspace: <new id>, role: 'admin' }`。
3. 幂等：如果 db_name 已存在（IdP 重发），return 200，不重复 INSERT。

### `POST /api/internal/membership-changed`

入参（IdP 推送）：

```ts
{
  dbName: string,
  subject: string,
  email: string,
  role: 'admin' | 'participant' | null,   // null 表示被移除
}
```

处理（root 会话）：

1. 查 `_system.workspace WHERE db_name = ?`。
2. role = null → `DELETE _system.user_workspace_index WHERE workspace = ? AND subject = ?`。
3. role != null → UPSERT `_system.user_workspace_index`（按 subject + workspace UNIQUE）。
4. **本 endpoint 不操作 ws db.user 表**——浏览器内管理员或 IdP 自身负责。后端 _system 只是缓存。

## Acceptance criteria

- [ ] 模拟 IdP 用正确签名调 `/workspace-created` → _system 两表都新增对应行。
- [ ] 错误签名 → 401，无副作用。
- [ ] 重复发送相同 payload → 200，无重复 INSERT。
- [ ] 模拟 `/membership-changed` role=null → 对应索引行被删。
- [ ] 模拟 `/membership-changed` role='admin' → 索引行被 upsert，role 字段正确。
- [ ] webhook payload 不含 IdP 内部敏感字段（密码 / refresh token 等）—— 由 IdP 端把关；后端只信"必要字段"。

## Blocked by

- `.scratch/workspace-as-db/issues/01-system-schema-seed.md`

## Notes

- IdP 选型还未定（见 ADR Open Questions），webhook 字段名以本 issue 草稿为准；选定 IdP 后回填。
- 共享密钥 vs mTLS：MVP 用共享密钥（实现简单）；上线前升级到 mTLS。
- 本 endpoint 不需要 OIDC verify——它面向机器对机器，鉴权走 webhook signature。
