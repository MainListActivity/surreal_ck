# 独立原生 P2P 传输原型

本目录独立 Rust crate，不修改 surreal_ck Web、服务端或数据库，也不向它们发送媒体/文件内容。依赖 `webrtc-rs 0.14.0`（MIT/Apache-2.0），版本固定在 Cargo.lock。该选型是可运行原型，尚非经过安全审计或性能验证的发布版本。

## 已实现

- `Peer::new(Route::Direct, stun_urls)`：第一轮只收集 host/STUN 候选，不配置 TURN。
- 失败后宿主可用 `Route::RelayFallback { urls, username, credential }` 新建连接，仅 TURN 候选。必须重新交换 SDP；不自动偷偷切换服务，也不会把文件上传 surreal_ck。
- `Peer::offer/answer/accept_answer`：完整 ICE gathering 后一次交换 SDP，15 秒超时；不是 trickle ICE。
- `chat::Chat`：创建/接受 JSON SDP、可靠 DataChannel 聊天、128 项有界事件队列、16 KiB 单条上限、发送队列背压。连接由宿主关闭。
- `transfer::Transfer`：在 Chat 的 ordered/reliable DataChannel 上进行 metadata offer → 用户批准目标路径 → 16 KiB 流式分块 → SHA-256 校验 → 原子无覆盖保存 → 应用级 ACK。最大 1 GiB，同一会话仅允许一个活动文件，逐块 ACK 限制在途数据。Linux/Android 接收使用固定父目录FD与匿名临时文件，从同一已校验inode发布；取消/关闭只释放匿名文件。不支持该安全原语的文件系统明确失败，macOS/Windows接收暂不可用，发送不受影响。不使用远端路径，不自动打开或执行文件。旧 `file::Receiver/frame/send` 保留为底层原语。会话 API、边界与验证见 [TRANSFER.md](TRANSFER.md)。不含断点续传、离线存储。
- `media::Media` 实现独立 Opus 麦克风、VP8 摄像头/屏幕轨，完整编码帧发送/接收、VP8 重组、默认禁用、PLI 关键帧请求和有界队列；详见 [MEDIA.md](MEDIA.md)。没有麦克风、摄像头或屏幕采集/编解码/扬声器渲染实现。

## NSH Rust 桥接

主工程依赖（若 manifest 在 `native-client/native/`，路径应为 `../../native-transport`）：

```toml
surreal-ck-peer-transport = { path = "../native-transport" }
```

```rust,ignore
use surreal_ck_peer_transport::{Route, chat::{Chat, Event}};
let (chat, mut events) = Chat::new(true, Route::Direct, vec![]).await?;
let offer = chat.offer_json().await?; // 通过已认证通道交给受信任对端
// 对端 Chat::new(false, ...) 后调用 answer_json(&offer)
chat.accept_answer_json(&answer).await?;
while let Some(event) = events.recv().await {
    match event { Event::Open => break, _ => {} }
}
chat.send_text("你好").await?;
// 持续 drain events 到 UI；需要主动 close，不能把 Drop 当作异步释放。
chat.close().await?;
```

## 加密与信任

DataChannel 使用 DTLS/SCTP，音视频用 DTLS-SRTP。TURN 只转发这些加密包，不是 SFU。加密不自动证明对端身份：SDP 指纹与会话身份必须经已认证信令绑定；手工信令只适合双方已验证的渠道。当前库不实现业务登录/会话授权/重放保护，也未承诺抵抗恶意信令服务 MITM。IP/端口和通讯元数据会被选定 STUN/TURN 服务看到。凭证仅运行时提供，不打印、不保存。

STUN 不是 relay。没有内置免费公共 TURN；可靠公共 TURN 通常需要账号、短期凭证、额度和滥用控制。当前无可用授权 TURN 服务配置，所以未实测公网 TURN 回退。LiveKit SFU 不等于 P2P，并非本实现依赖。

P2P 不会消除参与者上行，多人 mesh 会随人数增加而放大带宽；大型会议需独立媒体服务预算，不能承诺 mesh 无限扩展。直连会暴露对端 IP，隐私要求高时应从一开始明确选择 TURN。

## 平台范围

代码不依赖 WebView 或 NSH JS；适合 Rust native host 调用。当前仅云端 Linux Rust 编译通过；macOS/Windows/Android 均未完成目标编译或实机验证，不声称四端已兼容。Android 还需要 NDK/JNI、权限与生命周期集成，桌面还需各平台采集/渲染；屏幕权限、系统音频、硬编解码各有平台差异。

## 验证

```sh
cargo test --locked --manifest-path native-transport/Cargo.toml
cargo clippy --locked --manifest-path native-transport/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path native-transport/Cargo.toml --test loopback -- --ignored
```

2026-11-10 云端：文件边界、VP8 分片/丢包、错误 relay 配置、虚拟网络中文聊天、65,659 字节文件、SRTP Opus payload，以及 FFmpeg 真实编码音频/摄像头/屏幕三轨协议测试通过（7 通过，1 真实网络测试明确跳过）。fmt 与 clippy -D warnings 通过。虚拟网络运行真实 ICE/DTLS/SCTP/SRTP 协议，但包在进程内路由，**不是**真实 UDP、公网 NAT 穿透或设备采集验证。

真实网络测试曾运行并在 30 秒超时：云环境网卡枚举返回空，生成 SDP 没有 ICE candidate；因此保留 `#[ignore]` 明确要求具有 OS 网络接口的环境复测。没有改动系统/网络权限绕过这一限制。

尚未验证：跨机器连接、TURN、中断恢复、网络切换、浏览器互通、真实音视频/屏幕、长时大文件、四端构建、生产认证和依赖安全审计。这里是最小可集成传输底座，不是完整协作产品。
