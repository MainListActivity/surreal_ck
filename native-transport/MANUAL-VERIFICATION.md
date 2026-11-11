# 当前连接的人工核对

`manual_verification` 是无需数据库、SQL、生产 OAuth 或新凭据的独立 Rust 工具。
它不替代认证信令，不能创建企业 `AuthenticatedOffer` / `AuthenticatedAnswer`，
也不会自动把手工 SDP 对端提升为工作区成员。客户端已接入独立的人工核对面板；
该后续源码功能未包含于 stage7 APK。

## 接口与实际输入

- `ManualVerification::capture(&Peer, epoch)` 只读取同一 `RTCPeerConnection` 已生效的
  `current_local_description` / `current_remote_description`。要求 Connected、Stable、
  DTLS Connected 且没有 pending 描述。没有从粘贴文本、JSON 或 UI 自报身份构造的入口。
- offer/answer 按固定角色排列。分别显示完整 256 位证书 SHA-256，另显示完整 SDP 快照的
  SHA-256（带版本、长度和角色顺序）。全部分组为十六进制字符，不生成六位短码。
- 本地 SDP 指纹必须等于本地 DTLS certificate parameters；远端指纹必须等于真实握手
  获得的远端 DER certificate 的 SHA-256。空证书、未连接或不一致都拒绝。
- `confirm_after_trusted_channel_comparison(peer, epoch, displayed)` 仅应由用户明确操作调用。
  传入用户当时看到的完整材料，不可将过时弹窗的内容自动替换为最新材料。
- `matches_current` 重读 Peer、已生效描述及证书。`status` 在检测变化后永久变成
  `Invalidated`，不会在连接恢复后自动恢复确认。`invalidate` 供宿主主动撤销。
- `Chat::connection_epoch()` 返回当前代次；`connection_epoch_observer()` 返回可 Clone 的
  只读 `ConnectionEpoch`，UI 消费异步结果时可用 `current()` 再读真实代次。
  既有状态回调及 DataChannel 关闭回调在构造发送 future 前就增代，队列满不阻止撤销；所有 Chat 协商/关闭
  API 入口也先增代。计数初始为 1，耗尽后永久为 0，不回绕，核对模块拒绝 0。

`ComparedViaTrustedChannel` 的含义仅是“用户声称通过已有可信渠道核对了这个连接快照”。
软件无法证明用户确实进行了比较；它不是认证凭证、授权 token 或对方实名的证明。

## 必须由宿主落实

1. 单一后台 actor 串行处理连接/协商/确认，避免异步读取与协商竞态。
2. 每次 offer、answer、重新协商、重连、关闭及会话替换前，递增本地非零 epoch，
   立即 `invalidate` 并丢弃旧对象。epoch 不共享给对方，禁止回绕或复用。
   使用 Chat API 时沿用其只读 epoch；直接调用低层 Peer API 的宿主必须自行执行上述规则。
3. 连接丢失/失败时立即撤销；不得仅依赖稍后检查时仍然相同的证书。短暂断开后复连可能
   保留证书及 SDP，因此模块的快照检查无法独自发现未被宿主观察的历史状态变化。
4. 对话框、后台回调和 UI 更新携带同一 epoch；旧按钮或迟到事件不能确认新连接。
5. 展示“连接已建立”和“人工核对”两个独立状态，绝不显示为“企业成员已认证”。
   发送敏感聊天、文件或媒体前如何阻断未核对连接由产品另行决定，本模块不控制发送。
6. 人工比较必须通过预先可信的独立渠道或当面对照完整材料，不可让尚未核对的连接自行
   回传相同材料作为证明。双方均需自行明确确认；一方确认不会替另一方确认。

## 严格但有限的 SDP 支持

这是已通过 WebRTC 引擎协商后的额外防歧义检查，不是通用 SDP 引擎。支持当前项目的
单一 BUNDLE、SHA-256、同一 DTLS 证书、活动 application/audio/video m-line。
session/media 指纹继承可以接受，但同一作用域重复指纹、任意冲突、其他摘要算法、
缺失或非 32 octet 指纹均拒绝。类型必须恰为 offer/answer，媒体数量、MID 顺序、类型和
传输协议必须一致，origin、ICE、setup 和 BUNDLE 结构必须明确。

不支持的合法 SDP（例如多个 DTLS 证书、被拒绝的 port=0 m-line、非 BUNDLE）也会失败关闭，
只能继续显示未核对，不能为兼容性静默跳过。快照摘要包含全部规范化换行后的 SDP；
即便仅 ICE candidate 或非身份属性变化也要求重新核对。材料不显示原始 SDP、IP 或 ICE 密码。

## 威胁与不提供的能力

DTLS 证明当前传输证书与协商描述一致；人工通过可信渠道比较材料可帮助发现连接被替换。
哈希本身不证明对方是谁，不能把攻击者提供的 SDP 变成可信身份。完整指纹对照是标准证书
比较材料，不是承诺安全性的自定义密码协议或短认证串方案，不生成长期密钥。

裸 SDP 复制和人工比较不提供组织身份、成员有效性/撤销、权限、自动发现、可靠消息投递、
NAT 穿透或 TURN 服务。它不防御已被控制的端点、失陷的比较渠道或未认真核对的人。
SDP 本身仍可能含地址，只应交给预期对端；本模块没有远端请求或信息上传。

## 本地验证

离线复用现有目标目录，避免重复大构建：

```sh
CARGO_TARGET_DIR=native-client/target CARGO_INCREMENTAL=0 cargo test \
  --manifest-path native-transport/Cargo.toml --offline -j 1 --lib manual_verification \
  --config 'profile.dev.package.surreal-ck-peer-transport.debug=0' \
  --config 'profile.dev.package.surreal-ck-peer-transport.strip="debuginfo"'
CARGO_TARGET_DIR=native-client/target CARGO_INCREMENTAL=0 cargo test \
  --manifest-path native-transport/Cargo.toml --offline -j 1 --test manual_verification \
  --config 'profile.dev.package.surreal-ck-peer-transport.debug=0' \
  --config 'profile.dev.package.surreal-ck-peer-transport.strip="debuginfo"'
```

单元测试覆盖严格指纹解析、缺失/重复/冲突、类型与媒体会话不匹配、SDP 变更。
集成测试使用进程内虚拟网运行两组真实 ICE/DTLS/SCTP 握手，并包含 audio/video 轨协商，
核验双端材料一致、默认未核对、显式确认、错误材料、旧 epoch、替换 Peer、重新协商和关闭。
独立负例仅在测试里故意关闭引擎证书校验并篡改远端 SDP 指纹，完成真实 DTLS 握手后
确认本模块仍根据实际远端证书拒绝核对。生产构造器和默认配置不关闭证书校验。
另有真实连接状态回调测试：填满 128 项事件队列，在不消费队列的情况下关闭引擎，
验证只读 epoch 在发送状态事件等待队列之前已变化；计数溢出测试要求永久失败关闭。
远端 SCTP 关闭负例另外检查 Peer 仍 Connected 时，DataChannel 关闭回调也独立推进 epoch。
这不证明互联网/NAT/TURN、手机/桌面设备、真实用户对照行为或组织身份。

2026-11-10 冻结源码验证：完整 transport 测试 20 通过、1 个既有真实 OS 网卡测试按原因
跳过；`clippy --all-targets -- -D warnings`、`cargo fmt --check` 与 `git diff --check` 通过。
复用 `native-client/target`、离线依赖、禁增量编译，仅 transport leaf 禁调试符号；无新增依赖。
