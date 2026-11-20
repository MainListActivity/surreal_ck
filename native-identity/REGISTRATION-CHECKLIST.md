# 原生身份登记与联调检查单

## 已完成的公开只读核实

2026-11-10 17:07–17:11 UTC，仅使用无 Cookie、无 Authorization、禁止跟随重定向的 HTTPS GET：

- [线上 discovery](https://o.maplayer.top/t/ck/.well-known/openid-configuration) 返回 200：issuer 为 `https://o.maplayer.top/t/ck`；authorization、token、JWKS 端点分别为同 issuer 的 `/authorize`、`/token`、`/jwks.json`；声明 `authorization_code`、`code`、`S256`、`none` 与 `RS256`。
- `scopes_supported` 包含 `openid` 及运营 `content.*`，没有 `profile` / `email`。客户端现只请求 `openid`，public 模式必须确认该声明。
- [线上 JWKS](https://o.maplayer.top/t/ck/jwks.json) 返回一把 RSA / RS256 / sig 公钥。没有请求任何 token。
- [线上 Web bundle](https://l.maplayer.top/assets/main-DUvNNZKT.js) 的公开配置为：client `b10df483-1cd4-4beb-8a01-92e8f4b3fdf4`，callback `https://l.maplayer.top/auth/callback`，audience `https://auth.maplayer.top`，API `https://l.maplayer.top`，数据库 `wss://data.maplayer.top/rpc`。此 bundle 不证明 IdP 回调白名单的完整内容，更不证明原生 callback 已登记。

未发起 `/authorize`、换票、注册或登录；未读 `.env`、secret、真实用户令牌或业务数据；未修改远端。线上部署 commit 与跨 client `/scope` 行为仍未验证。

## 最小桌面 public client 配置

优先由部署方提供已有 client 的非敏感登记信息。只有不存在匹配 client 时，才在明确批准后登记一个独立原生 client。下面回调是具体提案，不是已登记事实：

| 字段 | 必须匹配的值或要求 |
| --- | --- |
| tenant / issuer | `ck` / `https://o.maplayer.top/t/ck`；管理 API 的 tenant UUID 仍需部署方确认，不能用 slug 猜测 |
| client_name | 建议 `吉吉桌面原生客户端` |
| client_profile / application_type | `native` / `native` |
| token_endpoint_auth_method | `none`，原生包不包含 client secret |
| grant_types / response_types | 仅 `authorization_code` / `code` |
| PKCE | 必须 `S256` |
| redirect_uris | 精确 `http://127.0.0.1:43123/auth/callback`，含端口与路径；不登记 wildcard / regex / 随机端口范围 |
| access_token_audience | `https://auth.maplayer.top`，与产品后端 confidential client 完全一致 |
| OAuth scope | 仅 `openid`；不申请运营 `content.*`、`offline_access`、机器 grant 或 agent exchange |
| trust_level / consent_policy | 已核实版本的管理登记 schema 只接受 `first_party_trusted` / `skip`；须披露并明确批准此行为，不能静默把第三方应用登记成免同意的一方应用 |
| 真人登录方式 | 仅启用组织已有并批准的一种方式；不为测试开放自助注册，不更改 MFA 策略 |
| client_id | 由已批准登记结果返回，未确定前保持配置缺失而不是填假值 |

最低 claim 约定：ID token 有可信 `iss/sub/aud/iat/exp/nonce`；access token 有可信 `iss/sub/aud/iat/exp/client_id/scope`。实际业务还需部署方沿用产品默认工作区 hook 与必要 claim 映射：`db` / `ac` 来自 hook，`email` 可由 IdP 现有用户字段映射供尚未绑定 subject 的成员定位，管理员所需 `RL` 仅按既有 access 规则解释。不得把 `db` / `ac` 写死为某工作区、创建账号、添加成员或提升角色来让验证通过。客户端只读操作并不把管理员 token 降为只读；首轮应使用已存在、已授权的普通成员测试账号。

`audience=` 查询参数不能设置 IdP 签发的实际 audience。已核实 ma_hono `02ed958f` 的 authorize handler 不读取该参数；实际 audience 来自已登记的 `access_token_audience`（运营资源另有 `resource` 约束）。`openid` 已足够签发身份 token；额外 claim 的解析不依赖 `profile` 或 `email` scope。

不要直接使用 discovery 的 `registration_endpoint=/connect/mcp/register`：该端点登记的是运营 MCP resource `https://l.maplayer.top/api/ops/mcp` 的客户端，不是产品工作区客户端。管理注册和 claim hook 变更是持久访问配置，必须单独确认。现有 hook 的认证材料只在已授权管理渠道配置，不读取、复制到仓库或要求用户在聊天粘贴。

确认登记后，编译配置为：

```text
SURREAL_CK_OIDC_ISSUER=https://o.maplayer.top/t/ck
SURREAL_CK_API_BASE_URL=https://l.maplayer.top
SURREAL_CK_OIDC_CLIENT_ID=<实际获准的原生 client_id>
SURREAL_CK_OIDC_TOKEN_MODE=public-pkce-discovery
SURREAL_CK_OIDC_ALLOWED_HOSTS=o.maplayer.top
SURREAL_CK_OIDC_AUDIENCE=https://auth.maplayer.top
SURREAL_CK_NATIVE_REDIRECT_URI=http://127.0.0.1:43123/auth/callback
SURREAL_CK_SURREAL_URL=wss://data.maplayer.top/rpc
SURREAL_CK_SURREAL_NS=main
```

namespace `main` 来自仓库约定，仍需部署方确认。业务仍受客户端更新门禁约束，身份配置不能绕过生产更新信任配置。

## 不改登记的既有路径

只有部署方证明现有产品 confidential client 已批准同一个精确 loopback callback，才可使用默认 `/api/auth/token` 路径，且 native client_id 必须与代理后端一致。单纯持有 Web callback 或公开 client_id 不满足此条件。现有 HTTPS Web callback 不能由当前 loopback receiver 接收，不可通过复制授权码或 token 代替原生流程。

public native client 不能调用该 confidential proxy：代理明确丢弃传入 client_id，并使用固定后端 client。不能借用运营 public client 或运营 proxy，因为 audience、权限与用途不同。

## Android 缺口

默认构建与已有实验 APK 仍未包含 OAuth 接收宿主。新源码增加默认关闭的 `android-native-oauth`：系统浏览器入口、内存单次路由、Activity/JNI、精确 URI/state/issuer 验证、取消/迟到/重复回调隔离及进程重建失败关闭。双 ABI Android check/严格 clippy、实际 SDK Java 编译和纯生命周期负例已通过；尚未将独立 `auth-manifest.xml` 与 Java 类纳入打包，也未设备验收或真实登录。不能把源码检查当 APK 可登录。

`top.maplayer.collaboration:/auth/callback` 仍只是候选 scheme，尚未注册或获准。待宿主打包与系统浏览器往返验收后，才申请登记；custom scheme 可能被其他应用争抢，不能称 verified App Link。若采用 App Link，还需确定 HTTPS 域名、包名和正式签名绑定。详见 `native-media-platform/android/AUTH-HOST.md`。

## 动作时确认边界

1. **登记**：只针对 ma_hono 的 ck 组织配置一个上述桌面 native client，并沿用必要的产品 audience/claim hook。披露它会增加原生应用可发起组织登录的持久入口，用户角色仍由现有工作区决定。不要请求所有管理员权限；可由部署方代为登记并仅返回非敏感结果。
2. **真实登录测试**：另确认指定已有测试账号与工作区，允许在系统浏览器向 ma_hono 登录、把身份与现有工作区 claim 交给本机原生应用，并把临时 bearer 交给 `l.maplayer.top` / `data.maplayer.top` 以读取工作区列表及当前工作区成员姓名、邮箱和角色。只用内存会话，不保留 refresh token，不更改成员或业务内容。登录、默认 scope hook 或数据库认证可能更新正常审计/最后访问状态，不能称零写入测试。还需确认线上 IdP 的 refresh 行为：已核实源码即使 scope 只有 `openid` 也会签发 refresh token 并保存服务端记录；原生端忽略该字段不代表服务端未创建它。不得承诺“没有持久凭据产生”，也不在未经批准时自行改 IdP 或调用 revoke。
3. **切换工作区**：需要单独明确选择目标；服务端会更新 `last_selected_at`，并可能按既有规则修复 subject 绑定，不能把它当纯只读探测。首轮可不切换，只检查 token 当前 scope。

企业登录成功也不等于 P2P 对端已认证。当前手工 SDP 连接码与成员目录没有绑定；认证信令仍需把 workspace、双方 subject、会话唯一标识、SDP 指纹和有效期绑定到受认证交换，并拒绝重放/跨工作区/被替换对端。该工作未实现，本次不增加信令服务或数据库权限。

## 源码证据

- [ma_hono authorize 参数与 redirect 校验](https://github.com/MainListActivity/ma_hono/blob/02ed958f430a2b482b8c67ec4ede2aa73426e1b2/src/domain/authorization/authorize-request.ts)
- [ma_hono claim 解析与 audience 来源](https://github.com/MainListActivity/ma_hono/blob/02ed958f430a2b482b8c67ec4ede2aa73426e1b2/src/domain/tokens/token-service.ts#L848-L887)
- [ma_hono 同租户同 audience 跨 client scope 条件](https://github.com/MainListActivity/ma_hono/blob/02ed958f430a2b482b8c67ec4ede2aa73426e1b2/src/domain/tokens/token-service.ts#L1030-L1062)
- [ma_hono 资源 scope 约束](https://github.com/MainListActivity/ma_hono/blob/02ed958f430a2b482b8c67ec4ede2aa73426e1b2/src/domain/oidc/resource-policy.ts)
- 本仓库：`server/src/routes/auth.ts:53–101`、`server/src/oidc/verify.ts`、`server/src/workspaces/workspace-scope.ts`、`native-client/src/identity_ui.rs:232–250`、`native-transport/README.md`。

这些源码事实不替代线上登记或真实登录验收。管理 client 详情 GET 在旧账号缺少 policy 时可能写入默认 policy；若后续需要纯只读配置核查，优先管理员提供脱敏结果，或核实无副作用的列表接口，不把所有 GET 都当无状态读取。
