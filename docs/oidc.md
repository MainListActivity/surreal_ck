请帮我在当前项目里实现一套和 MaPlayer 一样的 OIDC -> SurrealDB 鉴权链路，要求如下：

1. 使用 OIDC Provider:
- Issuer: https://o.maplayer.top/t/ck
- Authorization Endpoint: https://o.maplayer.top/t/ck/authorize
- Token Endpoint: https://o.maplayer.top/t/ck/token
- JWKS: https://o.maplayer.top/t/ck/jwks.json
- Client ID: b10df483-1cd4-4beb-8a01-92e8f4b3fdf4
- Audience: https://auth.maplayer.top
- Scope: openid profile email
- 登录流程必须使用 Authorization Code + PKCE(S256)

2. 在SPA实现：
- start_login(): 生成 code_verifier、code_challenge、state，并拼 authorize URL
- handle_callback(code, state): 校验 state，向 token endpoint 换取 access_token / refresh_token / id_token
- 把 tokens 持久化到本地存储
- valid_access_token(): 返回可用 access token；如果即将过期则优先用 refresh_token 刷新
- logout(): 清除本地 tokens

3. access token 在auth中获取，并存储。

4. 在 SurrealDB 连接层实现：
- connect() 后先 use_ns / use_db
- 再调用 db.authenticate(access_token)
- token 认证失败时断开连接并标记为 auth failed
- 用户身份使用 JWT 的 sub 映射为 record id: app_user:<sub>

5. 在 SurrealDB schema 中配置 JWT 鉴权：
- 使用 JWKS URL: https://o.maplayer.top/t/ck/jwks.json
- 校验 aud 必须包含或等于 https://auth.maplayer.top
- 从 token.sub 创建或定位 app_user 记录
- 让表权限基于 $auth.id 生效

6. 请给我：
- 完整实现代码
- 关键流程说明
- token 存储结构
- 刷新策略
- SurrealDB schema 示例
- 需要暴露给 UI 的最小接口列表
