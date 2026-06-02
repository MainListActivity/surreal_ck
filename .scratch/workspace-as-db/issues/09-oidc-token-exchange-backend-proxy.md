Status: done
Label: ready-for-agent

# WP-C-09 — OIDC token exchange 改走后端 confidential proxy

## Parent

`.scratch/workspace-as-db/PRD.md`

## What to build

把 Web 登录流程中的 OIDC token exchange 从“浏览器直接调用 IdP token endpoint”改为“浏览器调用本应用后端 token endpoint，由后端作为 confidential client 补充 `client_secret` 后向 IdP 换取 token”。

对前端语义保持最小变更：浏览器最终仍拿到 IdP 签发的 `access_token`，并继续把它作为本应用 API bearer token 与 SurrealDB `db.signin` token 使用。不要引入 opaque app session，也不要把 `refresh_token` 或 `client_secret` 暴露给浏览器。

这条 slice 完成后，用户可按现有登录入口进入 IdP 完成授权；callback 页面仍能拿到可用的 `access_token`；Workspace Scope Module、`requireOidc()` 和浏览器直连 SurrealDB 的认证模型不变。

## Acceptance criteria

- [x] 前端 OIDC callback 不再直接请求 IdP token endpoint，而是请求本应用后端 token exchange endpoint。
- [x] 后端 token exchange endpoint 接收现有授权码交换所需参数，补充 server-side confidential client 凭证后请求 IdP token endpoint。
- [x] 后端返回的 token response 与前端现有会话存储兼容，至少包含可用于 `requireOidc()` 和 SurrealDB `db.signin` 的 `access_token` 及过期信息。
- [x] `client_secret`、`refresh_token`、授权码和 `access_token` 不出现在前端构建产物、URL query、普通日志或错误响应中。
- [x] 现有 workspace 列表、切换 workspace 后刷新 token、浏览器重新 `db.signin` 的路径继续使用同一个 `access_token` 模型。
- [x] OIDC 文档和环境变量模板更新为 confidential client 口径：secret 只存在于后端环境变量，前端只知道后端 token exchange endpoint。
- [x] 单测覆盖成功交换、IdP 失败透传/归一、缺失参数、secret redaction，以及前端 callback 后 `getToken()` 仍能读到 access token。

## Blocked by

None - can start immediately

## Comments

2026-05-31: TDD 完成。新增 `/api/auth/token` 后端 confidential proxy；前端 `oidc-client-ts` 通过 `metadataSeed.token_endpoint` 指向后端；浏览器仍保存 IdP `access_token`，不引入 opaque app session。
