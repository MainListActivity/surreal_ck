# 桌面通话生命周期桥接

独立 Rust crate：用户明确选择的真实 FFmpeg 采集 → `native-transport::Media` 的 Opus/VP8 WebRTC → 原生 FFmpeg 解码/ffplay 音频 → 宿主提供的有界 RGBA mailbox。没有 WebView，也没有缺设备时替换成测试画面的代码。

当前支持编译的桌面类型为 Linux、macOS、Windows；Android 只导出 `supported() == false`，不暴露桌面调用 API。Android 须走另一个 MediaCodec/系统权限/Surface 宿主，不会偷用 FFmpeg 子进程。

## 稳定接口与调用次序

```rust,ignore
use std::sync::Arc;
use surreal_ck_native_call::{CallSession, CaptureInput, Source, VideoConfig, VideoSink};

// Chat 已创建，但此时必须尚未 offer_json / answer_json。
// camera_view/screen_view 是真正注册过的平台原生视图 mailbox。
let sink: VideoSink = Arc::new(move |source, width, height, rgba| {
    let publisher = match source {
        Source::Camera => &camera_view,
        Source::Screen => &screen_view,
        Source::Microphone => return Err("音频不能写入视频视图".into()),
    };
    publisher.present(
        surreal_ck_native_video_view::RgbaFrame::packed(
            u32::from(width), u32::from(height), rgba,
        ).map_err(|e| e.to_string())?
    ).map(|_| ()).map_err(|e| e.to_string())
});
let (mut call, events) = CallSession::attach(&chat, sink).await?;
// 然后进行经过认证的 offer/answer 交换；本 crate 不替代信令身份校验。

// 每项只由独立的用户操作触发；下面的设备值必须来自本次用户选择。
call.start_capture(Source::Camera, CaptureInput::Camera {
    device: selected_v4l2_path,
    video: VideoConfig { width: 640, height: 360, fps: 30 },
}).await?;
call.set_remote_video_enabled(true).await?;
call.set_remote_audio_enabled(true).await?;

call.stop_capture(Source::Camera).await?;
call.set_remote_video_enabled(false).await?;
// UI 此时还须清除 mailbox，不能留下最后一帧冒充仍在直播。
call.stop().await?;
chat.close().await?;
```

- `attach(&Chat, VideoSink)` 返回 `(CallSession, tokio::sync::mpsc::Receiver<CallEvent>)`；拒绝已经设置 SDP 或已经有媒体 sender 的 Peer，默认本机采集、接收解码、音频播放全部关闭。
- 所有控制方法顺序使用 `&mut self`；`capture_active(Source)` 是当前 worker 状态，非设备枚举结果。失败后会变为 false。
- `start_capture(Source, CaptureInput)` 先验证轨类型，停止原采集，读取第一包真实媒体，最后才启用网络轨。首次设备读取最多5秒；失败立即停止，不回退合成源。
- `stop_capture(Source)` 先禁用网络轨，再取消并等待真实采集；不会关闭其他设备或改变远端播放开关。
- `set_remote_video_enabled` 与 `set_remote_audio_enabled` 独立；禁用等待 worker 退出。只有显式启用音频后，收到合法20ms Opus才创建 ffplay。
- `stop() -> Result<(), Error>` 幂等，禁用所有轨并取消/等待子进程与任务。`Drop` 也取消并 abort，FFmpeg 子进程 `kill_on_drop` 为最后防线；宿主仍应使用并等待 `stop()`。
- 独立监测 Peer 的 Disconnected/Failed/Closed 状态，立即关闭网络轨并取消采集/解码/播放；不会自动恢复或重新打开设备。子进程关闭超时/失败会返回错误并发送 Failed，不发送 CaptureStopped/Stopped，不把 kill-on-drop 当作已确认设备关闭。停止后的会话拒绝重启，重新通话需新建 Chat/CallSession。
- `CallEvent` 包含 CaptureStarted、CaptureStopped、RemoteVideoEnabled、RemoteAudioEnabled、VideoPresented、RemoteEnded、Failed { source, message }、Stopped。普通事件队列最多32项。宿主必须订阅 `capture_state()` 的权威watch快照：每源 Stopped/Running/Unconfirmed、revision与最近采集错误，不受普通队列饱和影响；UI只用快照改变采集隐私状态，不能让迟到普通Started/Stopped覆盖它。未知关闭会保留，重复空stop不会把它误清；已知无进程的空stop会发确认，允许启动失败后恢复UI。宿主必须持续消费并展示失败。VideoPresented 只证明 sink 接受了 RGBA，不能代替真实原生视图验收。

## 设备与权限边界

`CaptureInput`、`VideoConfig`、`Source` 从此 crate 重导出，精确的平台参数及许可限制见 `../native-media-platform/README.md`。设备信息只能由本机用户选择，不能从对端帧、聊天消息或 SDP 生成本机采集参数。

- Linux Camera 是显式 V4L2 路径，Microphone 是 PulseAudio source。X11Screen 是**指定 X11 display 的明确矩形区域**，不是窗口选择器；Wayland 未实现 portal，会拒绝。
- macOS MacVideo 索引可能指摄像头或屏幕，宿主必须重新枚举、显示名称并明确区分来源。索引不稳定，桥接不会在关键帧恢复时偷偷重开旧索引。
- WindowsCamera/WindowsMicrophone 是明确 DirectShow 名称；WindowsScreen 是明确桌面矩形，不是 Windows Graphics Capture 系统选择器。
- 请求权限和系统录屏指示由平台宿主负责，桥接不修改权限、不隐藏指示、不默认共享所有屏幕。

## 有界与恢复策略

- 每视频源队列3帧，音频10包（最多200ms），传输层另有16事件上限。队列满即增加 epoch，淘汰所有旧包；视频等待下一个关键帧重新同步，音频停止旧播放器后按当前已启用的生命周期重建。取消优先，关闭后不会因迟到帧重开播放器。
- VP8 关键帧给出实际尺寸，验证宽1–1920、高1–1080，不接受缩放位或不可显示帧。合法尺寸变化重建解码器；不是假设固定640×360。IVF fps=30只是解码封装时间基，不承诺音视频同步。
- 解码使用平台 `VideoDecoder::decode_rgba` 并发写入 IVF/读取 RGBA，避免双向 pipe 容量死锁；每次I/O最多3秒。超时/部分帧失败后停止整个 decoder，不复用损坏流。5秒无视频停止空闲decoder。
- 传输 PLI 通知会要求正在运行的编码器送下一个真实关键帧；FFmpeg 已配置 `-g fps`，约每秒一个关键帧。期间舍弃 delta，最多等2秒；超时停轨并提示重新选择设备。没有把未实现的即时编码器 force-keyframe API伪装为已实现，也没有取消部分读取或擅自重开设备。
- 音频验证 Opus TOC 时长恰好20ms（48kHz的960采样），按 RTP timestamp 顺序处理；重复/逆序包丢弃，时间缺口和队列溢出清理旧播放器。不是完整 jitter buffer、丢包修复或 AEC。
- VideoSink 必须只是快速非阻塞 mailbox 写入；错误/异常停止对应视频 worker。宿主负责在关闭显示、RemoteEnded、Failed、Stopped 时清空视图，避免显示陈旧画面。

## 实际验证与交付限制

测试源只在 `tests/` 中，由明确标注的 FFmpeg lavfi testsrc2 生成，不触碰任何摄像头/麦克风/屏幕：

1. 真 FFmpeg VP8编码 → 真 WebRTC 的虚拟网络 ICE/DTLS/SRTP → 本桥接 → 真 FFmpeg流式解码 → Camera/Screen 独立RGBA sink，验证像素/透明度、64×48到96×64尺寸变化、启停/断开后不得恢复。
2. 缺失摄像头报错且不启用轨，无测试画面 fallback。
3. VP8尺寸/缩放边界、来源匹配、20ms Opus、RTP timestamp回绕、有界队列epoch及取消join单测。

云端 Linux 已实际通过20项桌面测试、strict clippy和fmt；Android aarch64/x86_64只验证明确 unsupported 的编译边界。macOS/Windows尚未在本任务执行目标系统编译或设备测试。

这是协议和解码测试，**不是两台真实设备网络通话、真实摄像头/麦克风/屏幕、硬件扬声器或可见原生视频窗验收**。暂不支持完整 AEC、音画同步、码率自适应或设备枚举。当前 FFmpeg/ffplay 来自可信已安装运行时；发布安装包仍须解决可信捆绑、许可与安全更新，不能让用户下载后自行猜测依赖。

```sh
cargo test --offline --locked
cargo clippy --offline --locked --all-targets -- -D warnings
cargo fmt --check
```


## 桌面停止与接收开关负例审计

- 取消 `start_capture` 或 `stop_capture` 的 future 会将该源保留为 Unconfirmed。只发出 kill-on-drop 不能作为设备已退出的证明；再次空 stop 不会误清状态。
- 全会话 `stop` 在首次 await 前写入未完成关闭结果。取消后重复 stop 必须返回未确认错误，不能把初始空结果当作成功。
- 接收播放切换先确认全部旧 worker 关闭，再创建新的 camera/screen worker，避免屏幕关闭失败后摄像头却已经重新启用。
- 接收 worker 关闭失败有持久闩锁；即使旧对象被取走，后续重开和最终 stop 也不能遗忘这个失败。
- 排队/等待旧 worker 期间被取消的允许播放请求不再迟到开启。已经发出的停止请求即使调用 future 被取消，仍执行停止。
- 合成媒体集成测试继续验证真实 FFmpeg → 虚拟网络上的真实 WebRTC → 解码 → sink；取消/关闭失败负例只注入受控清理任务，不冒充真实设备验收。
