# 原生企业身份、成员读取与固定信令

独立 Rust crate，依照当前 `web/src/lib/auth.ts`、`server/src/routes/auth.ts`、`server/src/routes/session.ts`、`web/src/lib/members-data.ts` 与 `docs/oidc.md` 实现。没有修改后端、IdP 注册或生产账号。

## 已实现

- 系统浏览器所需的真实 Authorization Code + S256 PKCE URL，独立的 256-bit verifier/state/nonce，一次性、5 分钟登录请求。
- 桌面 loopback 回调接收器：先绑定明确的 `127.0.0.1` 或 `[::1]` 与非零端口再打开浏览器；严格检查 method、Host、path、state、重复参数、请求大小和时限。关闭/取消即释放端口。
- 默认保留既有 `/api/auth/token` confidential proxy；可显式选择独立 native public client 的 OIDC discovery direct-token 路径。两种模式均没有 client secret，只请求最小 `openid`，不请求 `profile` / `email` / `offline_access`，不保存 refresh token。工作区 claim 由已登记 client 与服务端 hook 决定，不能靠增加 OAuth scope 获得。
- 从固定 issuer JWKS（proxy）或已验证 discovery 的 JWKS（public）验证 ID 与 access JWT 的签名、issuer、audience、subject、一致性、时间、nonce、azp 与可选 at_hash。仅允许 RS256/ES256，不信任 JWT 自带的外部 key URL，不接受未实现的 critical extension。
- Public 模式精确校验 discovery issuer，要求 `code`、`authorization_code`、`S256`、显式 `openid` scope、token auth `none` 和支持的 ID 签名算法；authorization/token/JWKS 均必须是显式主机白名单内的 HTTPS 443 地址。拒绝 userinfo/query/fragment、通配或后缀主机匹配及所有重定向。本次登录固定发现的 endpoints，回调不能改变换票目的地。
- `/api/session/workspaces` 权威列表；只有当前已验证 token 的 db/ac 与列表记录一致，才以该用户 token 直连 WSS `/rpc`，执行 `use → authenticate → 现有成员只读查询`。
- `switch_workspace` 为明确用户操作：先获取权威列表，再向既有 `/api/session/switch-workspace` 提交仅含 `workspaceSlug` 的 JSON 与当前 bearer。新 token 的签名、issuer/audience/sub/目标 db/ac/管理员 Owner 均须通过检查；不延长原会话期限，失败不替换旧 Session。
- participant 即使携带 `RL=[Owner]` 也不被视为管理员。数据库 PERMISSIONS 始终是最终权限边界。不存在 root/service 身份替代。
- `collaboration_session(_async)`：在已显式选定的工作区内，若当前 token 为 `ac=admin`（TYPE JWT，`$auth` 为空），向 `/api/session/collaboration-scope` 提交 `workspaceSlug` + `dbName`，后端核对该库存在 `kind='human'`、subject 精确匹配、未禁用的本人 user 行后，把同一主体降级为同库 `ac=participant`。新 token 必须验签且 iss/aud/sub 不变、db 为目标库、ac=participant、exp 不超过原 token；失败不替换原管理员 Session。当前 token 已是 participant 时直接复用。成员目录与信令使用该 participant 会话；管理员专用 HTTP API 仍用原管理员 Session。
- 协作直连（`load_members` / `SignalConnection`）接受与工作区角色一致的 token，或同库 `ac=participant` 的 RECORD 会话；严格 `require_scope` 不把 participant 视为 admin，db 不同一律拒绝。
- 所有 HTTP 禁止自动重定向、有超时和响应大小限制；网络错误不回显远端正文或凭证。Session 不支持序列化，Debug 隐去 token，令牌仅存在内存并在拥有的缓冲区释放时清零。

## 接口与配置

公开构造入口：

- `IdentityConfig::new(issuer, api_base, client_id, audience, redirect_uri)`：默认 `OidcTokenMode::ConfidentialProxy`，只验证格式，不代表回调已注册。
- `config.with_public_pkce_discovery(&["o.maplayer.top"])`：显式选择 `OidcTokenMode::PublicPkceDiscovery`，白名单来自受信任发布配置，必须包含 issuer 主机。不是注册请求；不会尝试创建 client。
- `config.token_mode()`：读取模式。
- `IdentityConfig::from_env()`：读取下列显式配置，不提供假客户端或原生回调缺省值。
- `IdentityClient::new(config)` / `begin_login_async().await`。同步 `begin_login()` 在 public 模式包含 discovery 网络请求，只供工作线程。
- `LoopbackReceiver::bind(&attempt)` 必须在打开浏览器之前成功；`receive(self, &attempt).await` 返回暂存于清零缓冲区的 callback URL。
- 平台 receiver 可调用 `attempt.remaining()` 获取正数剩余期限，以及 `attempt.validate_callback(&str)` 预检精确 URI / state / 可选 issuer / 参数与有效期；二者不换票，也不延长或消费请求。合法拒绝回调返回 `LoginRejected`，应作为终态处理。receiver 自己负责单次接收、取消路由与丢弃重复/迟到回调；不能用预检成功代替登录成功。
- `attempt.finish_async(callback).await` 消耗登录请求并换票。同步 `finish` 仅供工作线程。
- `client.list_workspaces_async(&session).await`，同步版本仅供工作线程。
- `load_members(&client, &session, &surreal_config, slug).await` 每次重新取权威列表，只允许当前 token 对应工作区。
- `client.switch_workspace(&session, slug)` 为同步调用；`client.switch_workspace_async(Arc<Session>, String).await` 为异步调用，返回验证后的新 Session。绝不自动切换。只有 UI 明确选定工作区时才调用，后端会更新 `last_selected_at`。取消等待不保证已发出的后端请求被撤回；丢弃迟到结果并不回滚服务端最近选择。
- 登出：关闭/取消 pending receiver、清掉 Session 和成员 UI。没有服务器撤销端点时不宣称服务器会话已撤销。

配置名称：

| 配置 | 用途 |
| --- | --- |
| `SURREAL_CK_OIDC_ISSUER` | 已核实的 HTTPS issuer |
| `SURREAL_CK_API_BASE_URL` | HTTPS 应用 API base |
| `SURREAL_CK_OIDC_CLIENT_ID` | proxy 模式对应后端 confidential client；public 模式对应独立已注册 public client |
| `SURREAL_CK_OIDC_TOKEN_MODE` | 缺省或 `confidential-proxy` 保持旧行为；显式 `public-pkce-discovery` 直达 IdP |
| `SURREAL_CK_OIDC_ALLOWED_HOSTS` | public 模式必填，逗号分隔精确主机名；无通配/端口/URL；未知模式或空白名单拒绝启动 |
| `SURREAL_CK_OIDC_AUDIENCE` | access token 的资源 audience |
| `SURREAL_CK_NATIVE_REDIRECT_URI` | IdP 已批准且与平台接收器匹配的原生回调 |
| `SURREAL_CK_SURREAL_URL` | `wss://…/rpc` |
| `SURREAL_CK_SURREAL_NS` | namespace，缺省 `main` |

构建时注入公开配置也可调用 `IdentityConfig::new`。不要从回调、二维码或远端输入决定 issuer/API 地址。不要把 client secret、token 或 callback URL 放入发布配置、日志或 UI。

`Session`、`LoginAttempt` 和 `IdentityClient` 均为 Send。`begin_login_async`、`finish_async` 和 `switch_workspace_async` 使用阻塞工作线程，其底层请求不能强行中断：取消、登出或开始新登录后，调用方必须用代际标识丢弃旧请求的迟到结果。任何列表或成员加载同样不能使旧会话重新出现在 UI。

## 固定数据库信令

`SignalConnection::connect(&client, Arc<Session>, &surreal_config, slug).await` 会重新取得权威 workspace 列表，确认当前已验证 db/ac，再执行固定 WSS `use → authenticate`。当前仅支持真人 `participant` RECORD 会话，并额外核对 `$auth.id` 对应记录的 subject、human 与 active。`admin` TYPE JWT 没有可替代的 RECORD 身份，因此明确拒绝，不能从 UI 或成员目录代填 sender；工作区管理员需先经 `collaboration_session` 降级为本人 participant 会话。

- `database()` / `member_id()` 是已核对的连接身份；不导出 bearer 或通用 SQL。
- `invite(id, nonce, generation, recipient, offer, offer_hash)`、`inbox()`、`read(id)` 均为固定查询；创建 sender 只来自 `$auth.id`。
- `decide(&binding, accept)`、`answer(&binding, answer)`、`end(&binding)` 必须携带完整 `SignalBinding`，原子匹配 id、workspace、sender、recipient、nonce、generation、offer_hash、精确 `expires_at` 和前置状态。所有参数绑定，不拼 SQL。
- `SignalRow` 返回裸 64 位 lowercase hex id、完整 binding/status/SDP，以及服务端 `created_at` / `expires_at` / `server_now` 和 `expires_unix` / `server_unix: u64`。它只表示 DB 响应，不是可由 JSON 构造的已认证媒体证明。上层仍需核对邀请、SDP hash、会话代际与单调期限。
- 每次操作前后验证 Session 期限；`ensure_current()` 与 `session_expires_at()` 供宿主独立定时关闭已建立的通道。退出、切换账号/工作区或重建连接时应取消并丢弃旧连接/证明。
- `revalidate_peer(peer).await` 是固定只读查询，只在本人 subject 与 `$auth.id` 一致且双方仍为 active human 时成功。它不读取邀请，因此已建立聊天超过 120 秒邀请 TTL 后仍可检查。宿主可每 10 秒检查，任何失联/撤销/到期都关闭通道；这是周期检查，不是即时全局撤销或服务器通话租约。
- 客户端限制同连接邀请至少 10 秒、inbox 与同 id read 至少 3 秒；服务端 062 的写配额和 PERMISSIONS 仍是最终边界。断线/超时的写入返回 `SignalUncertain`，不得自动重复；其他写入错误也不能据此认定服务器一定未执行。丢弃后的连接不能用于继续信令。

固定 SQL 存放在 `sql/`。本模块没有迁移、部署、自动连接或 UI 开关；实际启用仍由产品配置与明确用户动作决定。真实本地 fork 覆盖范围与可复用夹具见 [信令验收记录](SIGNAL-VERIFICATION.md)。

## 真实阻塞与不支持的范围

1. 当前只有 Web confidential client 的公开发布配置证据，不能当作原生注册证明。`docs/oidc.md` 的 `https://docs.maplayer.top/callback` 是旧文档值；生产 runbook 与 2026-11-10 线上公开 bundle 均为 `https://l.maplayer.top/auth/callback`。`.env.example` 的 client 仍是占位配置。未读取 IdP 管理员注册配置，未确认已有原生 client/redirect，未注册 client 或读取 credentials。详见 [登记与联调检查单](REGISTRATION-CHECKLIST.md)。
2. `/api/auth/token` 会丢弃请求自带 client_id，强制用后端 confidential client。因此独立 native public client 必须显式选择本模块的 discovery direct-token 模式。已核实 ma_hono 提交 `02ed958f`：同租户且 subject client 配置 audience 和实际 token audience 都与产品 confidential client audience 一致时，后端可跨 client 换 workspace scope；必须是未过期的 active 真人 token，`content_reader` 被拒绝。换出票由产品 client 签发且只保留原 token 剩余有效期，所以本模块不把换票后的 client_id 改变误判为换人，但严格验证 sub 与目标 scope。源码能力不等于线上部署已支持，尚需部署方确认当前版本、public client auth `none`/S256、精确 callback 白名单、同租户同 audience，以及 access-token claim 配置；本模块不创建或修改这些配置。
3. loopback receiver 适用于桌面；custom scheme 可表示在配置里，但 receiver 会明确返回 `CallbackUnsupported`。Android 尚需平台原生回调路由，不能通过复制粘贴授权 code/token 伪装完成。
4. 成员访问仍只读；显式 workspace 切换方法已提供但没有自动调用。未实现成员添加/移除/改角色、refresh token 持久化、服务端 logout/revoke。本模块只提供固定信令原始行，消息对端的二次验证及通道生命周期由 native-signaling 与客户端负责。非当前 db/ac 的成员读取返回 `WorkspaceNotSelected`，不会偷偷换票或跨库查询。
5. 默认单测使用本机合成身份与协议夹具，不是生产 IdP 联调。另已显式运行固定 SurrealDB fork 的 RECORD 信令验收，覆盖真实权限/查询但使用仅限测试的本地 SIGNIN，不验证生产 OIDC 与 WSS 链路。没有使用真实用户令牌、修改线上数据或请求用户登录。生产集成仍需上述注册信息、授权测试账号和明确上线审批。

## 验证

```sh
cargo fmt --manifest-path native-identity/Cargo.toml --check
cargo test --manifest-path native-identity/Cargo.toml --locked
cargo clippy --manifest-path native-identity/Cargo.toml --all-targets --locked -- -D warnings
```

覆盖 RFC7636 标准向量、随机独立性、回调/过期/取消、JWT 负例与敏感错误、跨配置会话拒绝、participant 权限、真实本机 HTTP proxy 与 discovery/public token→JWKS→workspace→跨 client scope 流程、discovery/token 重定向与恶意主机拒绝、scope 失败保留旧会话、loopback 接收器和 WebSocket `use/authenticate/query` 协议。本机夹具的明文 HTTP/WS 仅在测试内部使用，公开生产配置拒绝非 TLS 服务地址。

IdP跨client规则源码参考：https://github.com/MainListActivity/ma_hono/blob/02ed958f430a2b482b8c67ec4ede2aa73426e1b2/src/domain/tokens/token-service.ts#L1030-L1062 。redirect匹配仍须精确登记明确loopback端口，不假设允许随机端口。

Discovery 源码参考：https://github.com/MainListActivity/ma_hono/blob/02ed958f430a2b482b8c67ec4ede2aa73426e1b2/src/domain/oidc/discovery.ts 。2026-11-10 17:07 UTC 真实无认证 GET 已确认线上声明 S256、token auth none、RS256 与 openid；JWKS 公钥读取成功。这只证明公开能力声明和公钥可达，不证明原生 client 已登记、用户已登录或跨 client scope 线上可用。
