# 原生媒体平台适配（实验接线）

本目录是原生平台实现，Android已有默认关闭的实验宿主桥，不是已验收的视频通话产品。未修改第三方NSH源码；未访问真实用户摄像头/麦克风、部署或推送代码。

## Linux 实现

依赖已安装的官方 FFmpeg/ffplay，须带 libvpx、libopus、V4L2、PulseAudio、X11 支持。系统 FFmpeg 的许可取决于构建配置；当前不捆绑或自动下载二进制，发布前须决定分发方案与许可证合规。

- `Capture::start(CaptureInput::Camera { device, video })`：真实 V4L2 设备采集，限定 `/dev/video数字`。不修改组、设备权限或提权。
- `Capture::start(CaptureInput::Microphone { source })`：真实 PulseAudio/PipeWire-Pulse source；用户选定后才能调用。
- `Capture::start(CaptureInput::X11Screen { display, video })`：仅显式 X11 display 的所选区域。检测到 Wayland 即返回 `PortalRequired`；未实现 portal，不绕过选择器。
- `next().await`：完整 VP8 编码帧或 20ms Opus 包；可直接对接 `native-transport::media::Media::send`。默认不启动任何设备，没有失败后偷偷输出测试图的逻辑。
- `VideoDecoder`：VP8 流式解码为 RGBA，实测不需要先关闭输入；限制首个关键帧与已批准尺寸相符。NSH 宿主仍需把 RGBA 放到真正图像/纹理节点，这里没有伪装视频窗。
- `AudioPlayer`：通过 ffplay 原生 SDL/Pulse 后端播放 20ms 48kHz Opus。不经过浏览器。硬件扬声器输出未测试；不会自动调用。
- 子进程无 shell 拼接，数据有界，kill-on-drop 和 `stop()` 释放采集；UI 取消、撤销、关闭通话时务必停止并等待任务，不能仅停止读帧。

示例顺序：用户操作及选择设备 → Capture::start → Media::set_enabled → next/send 循环；退出时先 Capture::stop 再禁用轨。接收 Frame 后 VideoDecoder::decode_rgba 或 AudioPlayer::write_opus_20ms。不要在 UI 线程执行管线。必须为 read/write 设置宿主超时并持续消费，避免设备失联导致长期等待。

## Android 实现

Java 源在 `android/src/top/maplayer/collaboration/media/`，API 28+，已用 Android 35 SDK 严格编译；**新增JNI、独立原生Activity、前台服务、真实解码Surface及默认关闭的客户端接线；尚未在稳定设备验收采集与通话**。详见 [MEDIA-HOST.md](android/MEDIA-HOST.md)。

- `NativeVideo`：MediaCodec VP8 surface encoder，Camera2 捕获，MediaProjection VirtualDisplay 捕获，关键帧请求，权限撤销 callback 关闭；`Decoder` 把 VP8 解码渲染到宿主提供的真实 Surface。
- `NativeAudio`：AudioRecord 原生麦克风采集、MediaCodec Opus 编码；`Player` 用 MediaCodec + AudioTrack 原生解码播放。设备可能没有 Opus encoder 或 VP8 surface encoder，此时明确失败，不假装支持。编码包时长需按平台 codec 输出 timestamp 校验，不能保证每台设备固定20ms。
- Sink 接收编码字节和时间戳，需主宿主通过 JNI 放到有界 Rust 队列并送 Media::send。反向把 Frame 交给 Decoder/Player，并正确换算 RTP timestamp。JNI和有界队列现已实现，运行结果仍须设备验证。

宿主必须实现的授权链：

1. 用户点击后才请求 CAMERA/RECORD_AUDIO runtime permission；拒绝就停止，不自行设置权限。
2. 屏幕使用系统 `createScreenCaptureIntent()`，拿到本次用户同意后创建全新的 MediaProjection。Android 14+ 不能复用旧 token。
3. 按 target SDK 配置 camera/microphone/mediaProjection foreground-service 类型和对应权限，启动可见前台通知；服务运行后才启动投影。不隐藏系统指示或通知。
4. 通话结束、系统撤销、Activity/Service 销毁时停止实际采集并释放 MediaCodec、Surface、AudioRecord/AudioTrack。麦克风 close 前先停止/join pump 线程。旋转或尺寸变化需停止并重建适配器；没有无缝重配实现。
5. Java Sink 不能长时间阻塞 codec callback；JNI 队列满要丢帧/请求关键帧，不无界积压。

这些类不是未经许可获取设备内容的后台入口。外部调用者需要有明确用户操作及适用的 Android 权限；适配器本身不弹权限框、不授予权限。

## 实测与阻塞

云端 Linux `cargo test --offline --locked` 7 tests 通过：

- FFmpeg 合成测试图真实编码 VP8 → 读取编码帧 → 实时解码 RGBA，未关闭输入就读到帧。
- FFmpeg 合成正弦真实编码 Opus → Ogg 解析和重新封装 → 解码 19200 字节非静音 PCM。
- 不存在的摄像头明确失败，绝不回退测试画面。
- 设备路径和尺寸边界拒绝。

fmt 和 clippy `-D warnings` 通过。Android 两个 Java 文件 `-Xlint:all -Werror` 编译通过，命令：`ANDROID_HOME=/path/to/sdk sh scripts/check-android.sh`。

合成源只存在 `#[cfg(test)]` 私有测试里，未暴露为生产设备。云端无 `/dev/video*`、`/dev/snd` 或桌面服务，真实设备/屏幕/扬声器测试未跑；网络媒体仍受云 OS 无 ICE 候选限制。不能据此宣称端到端视频通话、屏幕共享或 APK 功能已完成。

下一步：验收默认关闭的Android JNI/Surface/权限与前台服务接线、Linux RGBA 图像节点；在用户许可的真实设备完成摄像头/麦克风/屏幕选择、拒绝/撤销/退出与两机网络测试。Windows/macOS FFmpeg 入口见下节；尚未目标系统编译/实机测试或客户端接线。未实现完整 AEC、音视频同步、抖动缓冲、码率自适应、后台恢复，暂不能作为生产通话交付。


## macOS / Windows 桌面入口（待平台验收）

稳定共享路径为 `surreal_ck_native_media_platform::desktop::{Capture, CaptureInput, Encoded, VideoDecoder, AudioPlayer, VideoConfig}`；Linux 原来的 `linux::*` 保持兼容。没有新增 Rust 第三方依赖或改变锁文件。

- macOS：`MacVideo { device_index, video }` 使用 FFmpeg AVFoundation 的显式视频索引，索引可代表摄像头或屏幕；`MacMicrophone { device_index }` 使用显式音频索引。**索引不是稳定设备 ID**，宿主每次使用前必须重新枚举、标明屏幕/摄像头名称并让用户选择，不能记住索引后静默启动。屏幕与摄像头都输出 VP8，麦克风输出固定20ms Opus。
- Windows：`WindowsCamera` / `WindowsMicrophone` 使用 DirectShow 设备名称；`WindowsScreen { x, y, video }` 使用 gdigrab 捕获明确桌面矩形（允许负坐标的左侧屏幕）。不支持带冒号/引号的设备名，明确报错而非修改名称。设备重名、拔插后应重新选择；未实现枚举及稳定 ID 映射。
- 所有平台共用 FFmpeg VP8→RGBA 解码和 ffplay 原生音频播放入口。**RGBA 还没有放进 NSH 可见纹理节点，不能据此宣称视频窗已显示**；没有用 WebView 或测试画面代替原生渲染。客户端不能把这些独立入口当作已接线的通话 UI。
- `Capture::start` 拒绝不属于当前 OS 的输入后端，失败绝不回退到合成源。FFmpeg/ffplay 不自动下载、不自动安装；启动成功不等于设备已打开，首次 `next()` 的 EOF/错误或超时必须显示给用户并停止管线。
- Windows gdigrab 没有系统内容选择器，不等于 Windows Graphics Capture API；须由客户端展示准确分享矩形并由用户明确开启、显示持续分享状态和停止按钮。不自动分享所有屏幕、不捕获系统音频。macOS 目前是 AVFoundation 屏幕设备入口，**不是 ScreenCaptureKit 选择器实现**。

### 目标平台验收与签名要求

新 `.github/workflows/native-media-platform.yml` 配置了 Ubuntu、Apple Silicon macOS、Intel macOS、Windows 四个 runner，执行 check、fmt、clippy 及无设备参数测试。**只写入本地配置，未推送、未触发 Actions，未得到 macOS/Windows 编译结果**。云 Linux 已实际执行七项单元/FFmpeg合成测试及严格 clippy。参数测试覆盖 Mac 视频/音频索引、Windows 中文设备名、负屏幕坐标、越界矩形、组合设备语法拒绝、其他平台启动拒绝。

目标机器另须安装可信 FFmpeg（macOS AVFoundation、Windows dshow/gdigrab）以及 libvpx/libopus、ffplay/SDL。运行 `cargo run --locked --example desktop_capture -- --capture-selected-device <后端> <选择值> [y]` 可做约三秒手工设备检查：后端为 `mac-video`、`mac-audio`、`windows-video`、`windows-audio`、`windows-screen`；屏幕固定640×480且要求显式x/y。示例不保存、不发送捕获内容，视频检查真实编码→解码 RGBA，音频仅验证编码输出，**不验证扬声器或UI**。缺少显式参数立即拒绝。不要在 CI 自动传真实设备参数。

需要有登录图形桌面的 macOS/Windows 机器、摄像头、麦克风、扬声器/耳机及用户本次授权；hosted runner 编译不能代替这些测试。分别检查允许、拒绝、撤销、设备拔插、停止/窗口关闭、重复开关、屏幕布局变化、macOS Retina/Windows DPI与负坐标；再由两台真实设备测试网络传输、音画同步和回声。

macOS 发布需要宿主 Info.plist 的摄像头/麦克风用途说明和按实际沙盒配置适用的 entitlements，TCC 摄像头/麦克风/屏幕录制授权。授权归属外部 FFmpeg 与宿主打包方式有关，必须用最终签名包验证，不能假设 Terminal 授权自动覆盖 App。Developer ID、Hardened Runtime、签名内嵌辅助可执行文件和 notarization 所需凭证尚未提供；没有修改 TCC、授予权限或签名。若沙盒分发不支持当前子进程方案，需要改成原生媒体 bridge 后再发布。

Windows 需验证系统隐私设置允许桌面应用摄像头/麦克风访问；不自行修改开关。MSIX 分发时按最终包模型配置相应 capability 并测试。安装包/内嵌可执行文件的 Authenticode 签名证书及可信时间戳服务尚未配置；解码依赖的分发来源、许可、安全更新也需发布方案。无签名不妨碍本地开发测试，但不应宣称可正式分发。


大帧解码使用 `VideoDecoder::decode_rgba(&mut self, &[u8])`：在同一个真实 FFmpeg decoder 内并发写 IVF 与读 RGBA，避免双向 pipe 背压互锁。已在 Linux 实测1280×720、编码帧超过64KiB、连续三帧无需关闭输入即可输出RGBA。宿主须设置超时；超时/取消/I/O失败后停止或丢弃decoder，不复用部分帧状态；不得混用尚未消费输出的旧 `write` 调用。
