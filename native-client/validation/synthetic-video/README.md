# Linux 合成视频可见验收

这是独立测试宿主，不是生产客户端或发行包。生产 `App`、`main`、更新信任与更新门禁没有被该 example 改写，也未注入测试信任配置。

## 范围

- 两个实际同机 UDP WebRTC Peer，`Route::Direct`，无 vnet、STUN、TURN 或公网服务。
- A 单向发送 camera、screen 两条 **合成** VP8 测试轨到同一个 B。B 经现有 `CallSession` / FFmpeg 解码，再由既有 `native-video-view` GTK `GdkMemoryTexture` 显示两个视图。
- 同一会话另传输合成 Opus 并核对入站 SRTP 统计、收发一条中文 DataChannel 消息。音频播放保持关闭，未验收音频解码或扬声器。
- 输入仅为 `native-transport/tests/fixtures/` 已记录来源的 FFmpeg `testsrc2` / `sine` 素材。没有访问摄像头、麦克风、用户桌面或真实屏幕共享。
- 这不是两台设备、双向真人视频、生产身份认证、互联网/中继、拥塞控制或音画同步验收。

## 2026-11-10 最终版本实际结果（48 秒复验）

1. 两个原生视图真实可见，画面时码不同且持续变化。运行截图中 RGBA 69/69，入站 SRTP 包 328/324，Opus 345。GTK 对两个视图分别发送 320×180 的 `ready`。
2. 实际点击“注入坏帧”：3 字节畸形 RGBA 被构造边界拒绝；无效宽高 VP8 通过同一 SRTP 轨送达 B，接收端报告“无效的媒体帧或配置”。没有崩溃，后续合法关键帧恢复并继续可见，错误计数为 1。
3. 实际点击“停止接收并清空”：`CallSession::stop` 返回后两个纹理清空，GTK 各发送 `closed`。RGBA 固定在 318/318，A 继续发送约 9 秒，入站 SRTP 计数增长而 RGBA 不再增长。尝试重开接收被拒绝；重复停止保持关闭。
4. 实际点击“关闭两个 Peer”：Camera/Screen/Opus 三轨的迟到 `send` 全部拒绝；RGBA 保持 318/318。重复关闭保持已确认状态。
5. 关闭测试窗口后日志出现 `EXIT 两个 Peer 与解码子进程均已确认停止`。最终进程退出码为 **0**（`final-exit.txt`），全程 48 秒（`final-run.log`）。

## 证据

这里的 JPEG 均为 CUA 对独立测试窗口的实际截图，不含终端、内部工具界面或个人桌面。没有重绘或替换画面。

- `01-running.jpg`：双纹理正常显示、链路与接收计数。
- `02-bad-frame-recovered.jpg`：坏帧已拒绝、画面恢复。
- `03-stopped.jpg`：停止后的空白视图与冻结计数。
- `04-closed.jpg`：两个 Peer 关闭、三轨迟到发送拒绝。

以上四张截图对应最终复编后的完整复验。首轮较长运行的四张截图保留在 `initial/`，不能替代最终版本验收。

最终构建基线为 `2154b06e9bf2140667a76c8f8708bda341fe693b`，当时是有并行开发变更的脏树。构建前后列举的 Rust 源文件、Cargo manifest 和客户端 lock 摘要相同（`SOURCES_COMPARE_EXIT=0`）。后续提交不能把本次构建自动变成对 clean commit 的绑定。它是本地测试证据，不是签名发行包。

- `final-build.log`：实际基线、脏树状态、构建命令与 `BUILD_EXIT=0`。
- `final-sources-before.sha256` / `final-sources-after.sha256`：构建前后源摘要。
- `final-build-receipt.txt`：最终二进制和 example 源文件哈希、空间记录。
- `final-clippy.log`：最终 example 的 strict clippy，`CLIPPY_EXIT=0`；同次 `rustfmt --check` 通过。
- `SHA256SUMS`：最终四张截图和运行/退出记录摘要。

最终测试二进制 SHA-256：`26e8bc71235a9f75132969df3882da4808b12684f23af7b61c466b55378594bd`。

最终 example 源码 SHA-256：`2eee19f0a42c959fd6278d3a0b850b175ee8cca24acedb4650c001e1a2dd862d`。

## 复现

在具备系统网卡与图形会话、已有可信 FFmpeg 的 Linux 环境运行：

```sh
cd native-client
CARGO_INCREMENTAL=0 cargo rustc --offline --locked --features desktop \
  --example synthetic_video -- -C debuginfo=0 -C strip=debuginfo
./target/debug/examples/synthetic_video
```

可用本仓既有工具链/sysroot 环境变量，不需下载依赖或新建 target。构建复用 `native-client/target`；leaf 二进制约 180 MiB。无网卡的命令命名空间会因没有 ICE candidate 明确失败，不能将这种失败当成可见验收通过。

测试按钮分别触发坏帧、停止接收、关闭 Peer；关闭窗口会关闭命令端，等待媒体 worker 和 Peer 的清理。非 Linux 构建明确提示不支持，不伪装成目标平台已通过。
