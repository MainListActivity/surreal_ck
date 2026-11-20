# 已连接 Chat 的文件会话

`transfer::Transfer` 是 Rust 文件会话层，不是身份系统。当前 Chat 使用 DTLS/SCTP 加密和人工交换信令；**尚未将企业用户身份绑定到 DTLS 指纹**。宿主应向用户清楚说明对端验证方式，不能把通道加密显示成已验证的企业身份。

## 宿主接入

```rust,ignore
use std::{path::PathBuf, sync::Arc};
use surreal_ck_peer_transport::{chat, transfer};
use tokio::sync::mpsc;

let chat = Arc::new(chat);
let (tx, mut file_events) = mpsc::channel(128);
let files = transfer::Transfer::new(chat.clone(), tx);

// 用户选定文件并确认发送后，只发送 metadata，等待对方批准。
let id: String = files.offer(PathBuf::from("/用户选择的源文件")).await?;

// 持续按到达顺序消费 chat_events，不要给每个 Binary 并发 spawn。
match event {
    chat::Event::Binary(bytes) => files.handle_binary(&bytes).await?,
    chat::Event::Closed => files.close().await?,
    chat::Event::State(state) if state == "failed" || state == "closed" => files.close().await?,
    _ => {}
}

// 同时持续消费 file_events，并按 id 更新 UI。
// Event::Offer { id, name, size }: 显示名称和大小，弹出保存位置选择/接收确认。
// name 仅用于显示，绝不能拼接成目标路径或直接作为可信 HTML/终端内容。
files.accept(&id, PathBuf::from("/用户批准的完整目标文件路径")).await?;
// 或 files.reject(&id).await?；发送/接收中均可 files.cancel(&id).await?。

// Progress 的 done==total 仅表示分块已写入，不等于文件已经校验并保存。
// Completed { destination: Some(path), .. } 表示本地校验并保存成功。
// Completed { destination: None, .. } 表示对方保存 ACK 已到达，发送才算成功。
// Cancelled/Error 为终态；accept 路径错误则保留待确认状态，允许重新选择。

// 连接失败、关闭、退出或替换连接时必须调用，随后关闭 Chat。
files.close().await?;
chat.close().await?;
```

API（除 `new` 与 `receive_supported` 外均异步）：

- `Transfer::new(Arc<Chat>, mpsc::Sender<transfer::Event>) -> Transfer`，可 Clone。
- `offer(PathBuf) -> Result<String, String>`。
- `accept(&str, PathBuf) / reject(&str) / cancel(&str) / handle_binary(&[u8]) / close() -> Result<(), String>`。
- `Chat::send_binary(&[u8]) -> Result<(), String>`；事件新增 `chat::Event::Binary(Vec<u8>)`。
- `transfer::receive_supported() -> bool`：当前仅 Linux/Android 实现安全接收；文件系统是否支持仍在用户接受时检查。macOS/Windows 暂不支持接收，发送不受影响。

## 协议与边界

同一 Chat 最多一个活动传输，方向为发送或接收；繁忙时拒绝新 offer。发送和接收都只有 16 KiB 分块缓冲，源文件预先流式计算 SHA-256，不一次性加载文件；磁盘读写/哈希在 `spawn_blocking` 中执行。每块等待接收方 offset ACK，最多一块在途，最终保存另有独立 ACK。Chat 发送队列超过 256 KiB 等待，30 秒超时；分块 ACK 和最终 ACK 各等待最多 30 秒。等待用户批准不超时，取消或关闭会终止等待。

Unix 源文件使用 `O_NONBLOCK|O_NOFOLLOW` 打开并检查实际FD为普通文件，拒绝最终符号链接，避免路径被本地写入者换成FIFO后阻塞等待写端。普通文件仍按1GiB上限处理；这不等于可中断任意慢磁盘读取，也未声称Windows特殊文件边界已经实机验证。

二进制帧为 `CKF1`、1-byte 操作、16-byte 传输 ID 和有限 payload。操作 1=Offer、2=Accept、3=Reject、4=Chunk、5=ChunkAck、6=Finish、7=Complete、8=Cancel。Offer payload 是 8-byte BE 大小、32-byte SHA-256、2-byte BE UTF-8 名称字节数和名称；Chunk payload 复用 `file::frame` 的 8-byte BE offset。ChunkAck payload 为 8-byte BE 已接收字节数，其余控制消息无 payload。

文件上限 1 GiB，名称最多 255 UTF-8 字节，拒绝路径分隔符、控制字符、`.` 与 `..`，同时拒绝 Windows 盘符/ADS、设备保留名、非法字符与尾点/尾空格。这是对端提供的显示/默认名限制，不代替用户选择本地目标。ID 只用于会话去重，不作为认证秘密。协议不包含远端目录或本地目标路径。

接收方在 `accept` 前不创建/打开目标或临时文件，也不会发送文件内容。Linux/Android 在批准后逐层用 `openat(O_PATH|O_DIRECTORY|O_NOFOLLOW)` 固定父目录，拒绝路径中的符号链接和 `..`，再用 `O_TMPFILE` 创建0600匿名接收文件。没有可被本地目录写入者替换的 `.part` 路径。平台/文件系统不支持时在接受准备阶段明确失败，不发送 ACCEPT。

SHA-256 与大小都符合后 flush + sync 文件，再从仍持有的同一个文件描述符通过 `linkat` 原子创建最终目录项。无权限使用 `AT_EMPTY_PATH` 时，仅允许验证为真正 procfs 的固定 `/proc/self/fd` 作为同FD链接入口，不扩权、不退回路径复制或 rename。目标在批准之后出现也不覆盖；已有文件、目录与符号链接均拒绝。最终发布遇到权限或内核限制仍会明确失败，不发 COMPLETE。

发布前/后会重新核对用户选择的父路径是否仍指向固定目录。父目录移动或替换不能将内容写入替换目录；检测到漂移不报告完成。如果目录恰在原子发布后移动，已校验文件可能保留在原目录，错误会说明这一点，绝不按可能已被替换的名称删除别的本地文件。取消/关闭/校验失败只关闭匿名文件描述符，不操作不可信临时路径。这防护的是有本地目录写权限者的路径置换，不表示旧问题可由远端仅凭一个 offer 任意写本地文件，也不隔离能控制本进程的同一OS账户。

不支持匿名文件或无覆盖链接的目标文件系统会明确失败，不降级为可覆盖的 rename/copy。当前传输层要求普通本地文件路径，不接收 Android `content://` URI 或 SAF 文件描述符。Android 宿主先经明确接受保存到应用私有区，另行由用户触发 SAF 导出；传输 COMPLETE 只确认私有区保存，不能表示导出完成。当前 Android 客户端在接受前拒绝超过256 MiB的请求，以匹配既有SAF导出上限；协议层的1 GiB上限不表示Android UI可接收并导出同样大小的文件。SAF 实机权限、提供商行为和 Android 文件系统兼容性仍需验证。

没有自动打开、执行、修改可执行位、杀毒扫描、断点续传。文件数据已 `sync_all`，但不额外要求读取父目录的权限做目录 fsync，因此不承诺掉电后新目录项仍持久，也不承诺收到 COMPLETE 后能抵抗之后的本地修改/删除。

## 验证范围

```sh
cargo test --locked --manifest-path native-transport/Cargo.toml
cargo clippy --locked --manifest-path native-transport/Cargo.toml --all-targets -- -D warnings
```

测试通过真实 WebRTC 虚拟网络运行 ICE/DTLS/SCTP 和 Chat 二进制消息，覆盖多块文件、接收前无内容/无磁盘写入、显式批准/拒绝、保留最终 ACK 时发送方不能报告成功、损坏 hash、重复/乱序 chunk、取消、连接关闭清理、空文件、已有目标、批准后目标出现、恶意绕过接收确认和单活动文件限制。Linux合成文件测试实际调用内核 O_TMPFILE/linkat/procfs，验证同inode发布、0600/零链接临时文件、取消无命名残留、父目录改名后替换成目录或符号链接、已有/延后目标符号链接与只写/执行目录权限。底层writer单测另覆盖注入的部分写失败与flush失败；这些不是实际满盘测试。

虚拟网络在进程内路由，不能代替公网 NAT、TURN、真实 UDP、设备权限、跨平台文件系统和长时大文件测试。未完成 macOS/Windows/Android 实机文件传输验证。
