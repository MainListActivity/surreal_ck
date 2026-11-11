# 一对一音视频与屏幕传输

## 当前实装

`media::Media::attach(&Peer)` 在 SDP 协商前建立三个独立发送轨（microphone/camera/screen），两端都调用才能双向收发。`Chat::peer()` 可取得同一连接，因此文字和媒体复用一条 P2P/显式 TURN 会话。不会把媒体送给 surreal_ck。

- Opus 48 kHz 双声道（每包上限 1275 bytes），VP8 90 kHz RTP 时钟。
- 输入为原生编码器的一个完整编码帧，`Duration` 必须为真实帧间隔。禁止把 RGB/PCM 原始帧直接塞入。
- 发送前默认禁用所有源；`set_enabled` 只是网络发送开关，不冒充操作系统授权。
- 接收端输出完整 Opus 包/重组 VP8 帧，保留 RTP timestamp；原生解码器、音频播放/图像渲染由宿主负责。
- VP8 RTP 分片与重组、序号断裂丢帧、PLI 关键帧请求、RTCP/NACK 默认拦截器。PLI 反馈通过 `KeyframeRequested` 交给宿主编码器响应。
- 单帧上限 4 MiB，接收事件队列 16。队列满时丢帧而不是无限占用内存，视频请求关键帧（最多每 500 ms 一次）。没有成熟 jitter buffer、音视频同步、动态码率控制或拥塞自适应，不能声称生产通话质量。
- 关闭 peer 结束读取任务。停止屏幕共享时应先停止采集再禁用轨；已发送的包无法撤回。

## 接入顺序

1. 创建 Chat，调用 `Media::attach(chat.peer())`，保存 Media 和事件接收器。
2. 手工信令经可信渠道交换；生产还需 authenticated session/SDP 指纹身份绑定。
3. 用户点击麦克风/摄像头/共享屏幕后，宿主发起对应 OS 权限请求。拒绝或取消就保持禁用，不开始采集、不重试弹窗。
4. 成功后启动设备及编码器，`set_enabled(source, true)`，循环 `send(source, encoded_bytes, frame_duration)`。
5. 接收 `Frame` 后原生解码渲染；收到 `KeyframeRequested` 指示视频编码器强制下一帧 keyframe。
6. 权限撤销、设备消失、后台限制、退出时立即停止采集和编码任务、禁用 source、释放句柄。重启视频应先输出关键帧。先停止所有设备再 `chat.close()`。

本 crate 不在后台请求设备权限，不实现持续截屏，也不绕过系统选择器。

## 原生平台接入设计（未实现，非已兼容声明）

- Android：Camera2/CameraX；AudioRecord/AudioTrack；MediaProjection 必须由 Activity 显式用户同意，每次会话获取新的投影授权，前台服务及可见系统指示，遵循目标 SDK 限制；MediaCodec VP8 支持需运行时探测，Opus encoder/decoder 可走已审计库。JNI 将编码帧交给 Rust，Surface/AudioTrack 做解码播放。离屏销毁与 token 撤销立即停采集。未完成 JNI/NDK 采集桥接。
- macOS：AVFoundation 摄像头、CoreAudio 音频、ScreenCaptureKit 屏幕/窗口选择与 TCC；NSCameraUsageDescription/NSMicrophoneUsageDescription 必须配置。VP8 通常需软件编码，不能假设 VideoToolbox 提供 VP8；画面通过原生纹理交 NSH，不经 WebView。未实现这些平台模块。
- Windows：Media Foundation 摄像头、WASAPI 音频、Windows Graphics Capture 用户窗口/屏幕选择。VP8 编码能力需探测或明确带软件 codec；D3D 纹理到 NSH 平台渲染接口尚待实现。
- Linux：摄像头 V4L2、音频 PipeWire/PulseAudio；Wayland 屏幕走 xdg-desktop-portal + PipeWire，不绕过选择器。X11 与 Wayland 不同，不能用云端无桌面测试代替。可评估 GStreamer 原生管线，但当前未引入此运行时依赖。

设备层暂缺，不能说已经能视频通话或屏幕共享。实现和实测的是它们共用的编码媒体传输层。

## 实测证据

`tests/media.rs` 使用本地 FFmpeg `testsrc2` 和 `sine` 生成真实 VP8/Opus 测试内容。不是摄像头或屏幕录制。真实编码内容在显式进程内虚拟网络上经过 ICE/DTLS/SRTP，再分别按 camera、screen、microphone 三轨接收重组，逐字节与原编码内容比较通过；另测默认静音、停止共享后的发送拒绝、过大帧拒绝和 VP8 分片/丢包处理。

FFmpeg 解码原始 IVF 成功（3 帧，每帧 86400 raw bytes）；Ogg Opus 解码成功（19200 PCM bytes）。因传输后编码字节完全相等，可确定未损坏；仍不等于四端实时渲染验证。

真实 OS UDP 测试仍受云环境网卡枚举为空限制；没有硬件设备可测，没有已配置 TURN。不得将虚拟网络或合成测试图描述为真实设备通话。

### 关闭后的发送语义

`Media::send` 在源写锁内检查 Peer 仍存在且状态为 Connected，并在底层写入后复核状态。底层 track 在已解绑时可能仍返回 Ok，因此不能只依赖该返回值。未连接、关闭或写入期间断线会明确失败；成功仅表示仍连接的发送通道接受样本，不代表对端已收到或播放。同会话集成测试验证聊天、文件和三轨媒体关闭后都拒绝后续发送。
