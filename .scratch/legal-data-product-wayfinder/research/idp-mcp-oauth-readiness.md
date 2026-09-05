# 现有 IdP 的运营与 MCP OAuth 接入核查

## 范围与证据

只读检查 surreal_ck、相邻 ma_hono 源码及公开 discovery；未读取真实凭证，未注册客户端、签发 token 或修改部署。本地源码可能与线上版本不同，discovery 是声明而非完整互操作测试。

- 在线 discovery：[ck issuer metadata](https://o.maplayer.top/t/ck/.well-known/openid-configuration)。声明 authorization_code、refresh_token、S256、token endpoint auth none/basic/post、public subject；scopes_supported 仅 openid。
- 当前应用：[OIDC 文档](../../../../docs/oidc.md)、[浏览器配置](../../../../web/src/lib/auth.ts)、[token 校验](../../../../server/src/oidc/verify.ts)。当前浏览器通过后端 confidential client 换 token，统一配置 audience，并参与 workspace scope 分配。
- IdP 源码：`/Users/y/IdeaProjects/ma_hono/src/domain/tokens/claims.ts` 将 sub 设为 userId；`token-service.ts` 以 accessTokenAudience 或 clientId 决定 aud，custom claim hook 按 client 配置。
- 注册源码：`/Users/y/IdeaProjects/ma_hono/src/app/app.ts` 的 handleDynamicClientRegistration 要求 managementApiToken；不能把此凭证交给外部 MCP 客户端。
- `/Users/y/IdeaProjects/ma_hono/src/domain/clients/registration-schema.ts` 动态注册目前仅 authorization_code，默认 first_party_trusted/skip；管理员注册路径能力另行配置，不可把所有第三方客户端视为可信第一方。
- `/Users/y/IdeaProjects/ma_hono/src/domain/authorization/authorize-request.ts` 要求 openid；仅看到请求 scope 传递不能证明已有完整的 MCP scope 限制或逐客户端授权策略。

## 结论

现有 IdP 可以作为同一账号体系的基础，尚不能认定无需改动就可接入任意 MCP 客户端。

1. 独立 ops 与本地 MCP 客户端可预注册独立 clientId，沿用同 issuer/public sub。对已验证的身份使用服务端 platform_operator 判定，不从邮箱或用户填写参数推断权限。
2. 运营与 MCP 客户端不配置客户数据库 db/ac/RL hook；客户 web client 保持当前 workspace 登录路径。是否另加签发前运营检查可在接入时确定，服务端逐请求运营授权始终必需。
3. MCP access token 必须面向 MCP resource，不能只扩大现有 API 的 audience 接受范围。固定 client audience 有助于首期接入，但仍需验证 RFC 8707 resource 参数在授权、换 token 和刷新时的一致处理；当前检查未找到完整实现证据。
4. 用户明确要求 Codex 自动接入，首期必须提供动态客户端注册（DCR）。此前“优先预注册”的建议被替代。现有 managementApiToken 保护的注册接口不能直接供 Codex 使用，需新增或改造面向 MCP 客户端的受限注册路径；不把管理凭证交给客户端。
5. MCP 资源端需新增 Protected Resource Metadata、401 发现提示和专用 audience/scope 验证；OAuth scope 与当前运营能力取交集。IdP 应限制 client 可获 scope，不能仅把请求字符串原样签回。
6. 第三方客户端的授权提示与 consent 策略需要实测并配置；现有注册默认 skip 不能作为已经获得运营授权的证明。
7. 平台运营资格撤销通过每请求查询当前状态生效；OAuth refresh/revocation 的提供方行为另行测试，不能仅凭 discovery 推断完整撤销能力。

## 验收矩阵

- 同一运营账号使用 ops 与 MCP 登录，对应相同服务端身份；没有工作区仍可操作。
- 普通客户即使取得正确 audience token 也不能使用数据维护工具。
- 缺少 PKCE、错误回调、错误 audience/resource、过期 token、超出授予 scope 的调用被拒绝。
- 禁用运营或撤销发布能力后，已有 MCP 会话下一次调用被拒绝。
- 授权码兑换及 refresh 保持正确 resource/scope，不扩大权限；客户端重新连接不会丢失幂等边界。
- ops/token/MCP 凭证不被用来获取 _system 管理员数据库会话。

协议参考：[MCP Authorization 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)。需在实现时验证目标客户端与 IdP 的完整往返流程。

## 用户确定的 DCR 实施范围

- MCP resource metadata 指向支持 DCR 的授权服务器，discovery 正确公布可用注册端点；Codex 添加 MCP 地址后能发现、注册并进入浏览器授权。
- 动态注册创建受限 public client，采用 authorization_code + PKCE S256，不接收客户端自授的 first_party_trusted、skip consent、任意 audience、数据库 claim hook 或平台能力配置。
- 注册只创建客户端身份，不授予运营身份、数据权限或用户 token。真正访问仍需真人 OAuth 授权与 MCP 逐请求平台运营能力校验。
- 第三方客户端必须展示授权对象与所请求权限，记录授权和撤销；来源网页或工具内容不能替代用户 OAuth 授权。
- 回调 URI 按 public/native 客户端规范校验和匹配，支持目标 Codex 客户端实际使用的回调形式；具体行为以真实接入测试确定，不简单开放任意回调。
- audience/resource 与可申请 scope 由服务端限制；刷新不得改变目标资源或扩大已授予权限。
- 注册端点具备限速、输入大小限制、重复/失效客户端治理；保留现有管理注册能力的访问控制，不能通过删除全局鉴权开放原管理接口。
- 验收从一个未预注册的 Codex 客户端开始，完成发现、注册、授权、调用五个工具、刷新/重连及撤销测试；不得以手工拷贝 token 或预置 clientId 替代。
