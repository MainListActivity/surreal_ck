# 固定信令本地 fork 验收

验证日期：2026-11-10。没有连接生产、部署 migration、创建 IdP client 或使用真实用户令牌。

## 实测边界

- 使用已有固定 fork `3.3.0-native-quota.1+sha.f30704bce914`，二进制 SHA256：`6f6bcc72f8c23848295ed32d6a265f5bf0baad11e7be446294a5ade1b06a84f2`。
- 测试仅启动随机 loopback 端口和 memory 存储。Root 仅执行夹具 schema、种子成员与模拟控制面撤销；所有信令操作都使用实际 RECORD SIGNIN 得到的成员 token，执行生产的 `use → authenticate → query` 路径。
- 夹具加载仓库的 061/062，再仅在本地覆盖 participant SIGNIN 以建立合成测试身份。生产 OIDC/JWKS 验证另由已有密码学测试覆盖；本测试不能证明线上 IdP、原生注册、生产 WSS/TLS 或默认关着的客户端功能已经可用。
- 明文 HTTP/WS 与 Session 构造器仅在 `cfg(test)` 内部，公开生产构造器仍要求 HTTPS/WSS，没有 fixture feature、服务 token 回退或生产身份绕过。

## 已验证

- 权威工作区 HTTP 列表 → db/ac 校验 → 真正 WS use/authenticate → RECORD subject 对应的当前成员。
- 创建、inbox、完整读取、显式接受、一次 answer、end；sender 只能来自 `$auth.id`，绑定不匹配或状态不匹配拒绝。
- 非参与者、不同数据库、发送者冒充接受、错误 generation、重复 answer、终态复活均拒绝。
- 64 位全数字字符串 ID 经 `record::id(id)` 投影保留准确裸 ID，不被 record 字符串转义格式破坏。
- 精确服务端 expires_at CAS 与 server/expiry unix 秒；服务端未来期限限制。
- 本地频率限制；已过期 Session 在 connect、ensure_current、revalidate 时拒绝。
- 邀请已 ended 后仍可独立检查双方 active。控制面撤销接收者后，双方健康检查失败，新的 live 邀请无法接受、发送方无法继续读取。
- 同一个 RECORD token 不能配上另一个 subject 进入 SignalConnection。
- 固定 SQL 参数、错误脱敏、双方身份行严格数量与匹配的纯函数负例。

062 没有通话租约。周期成员检查存在检查间隔与网络超时窗口，不代表即时撤销；宿主必须在检查失败、登出、切换或会话过期时关闭通道。

## 复现

默认 `cargo test` 会明确忽略 real-fork 测试，避免没有执行就报成功。需显式提供该本地二进制：

```sh
SURREAL_TEST_BINARY=/path/to/verified/fork/surreal \
CARGO_TARGET_DIR=native-client/target \
cargo test --manifest-path native-identity/Cargo.toml --locked --offline --lib \
  --config 'profile.test.package.surreal-ck-native-identity.debug=0' \
  --config 'profile.test.package.surreal-ck-native-identity.strip="debuginfo"' \
  real_fork_signal_connection_roundtrip_and_denials -- --ignored --nocapture
```

全部 9 个 `.surql` 经 `@surrealdb/surql-fmt@0.1.0-beta.3` 格式化，并通过同一 fork CLI `validate`。

## 后续端到端夹具入口

`src/signaling_tests.rs` 的 `ForkFixture` 仅以 `pub(crate)`、`cfg(test)` 暴露。可在同一个 test crate 中包含真实 `src/lib.rs` 与上层 signaling/peer 源码，使用 `ForkFixture::start(binary)`、`session(name, database)` 或 `connection(name, database)`。现有三个合成人类成员为 `a` / `b` / `c`，两个隔离数据库为 `ws_signal` / `ws_other`。`revoke(name)` 只作用于本地 ws_signal。

这允许后续真正 WebRTC Chat 端到端验收复用真实数据库权限，不向产品公开 Session 构造器。本记录尚未声称验证 WebRTC/Chat、音视频或客户端 UI。
