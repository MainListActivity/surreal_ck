# r2：真实 X11 测试窗口采集（仅源码，未编译/运行）

r1 源码、素材、回执、二进制保持不动。本目录没有 synthetic_camera_sample 或编码样本注入。唯一包装是生产 enterprise_peer.rs 完整原样前缀追加测试模块；真实 EnterpriseMediaHandle.submit(Start(Screen, selection)) → 原 Call → 原 CaptureInput::X11Screen → FFmpeg x11grab/libvpx → 真实企业协商/OS UDP → 原 CallSession VP8 decoder → 原 FramePublisher/subscribe。bridge::Update 仍仅为事件承载替身，不是完整 UI 验收。

## 桌面窗口要求与许可范围

由桌面 worker 创建并人工/工具确认**仅测试窗口客户区**：640×360，无装饰、无缩放、固定坐标，完全无遮挡。整个客户区每约 1 秒交替 #ff0000 与 #0000ff。鼠标必须在区域外，测试期间不移动窗口、不允许其他窗口/通知遮盖。不能选择桌面全屏或任何非测试内容。

截图只能记录这个测试窗口，确认窗口 id、DISPLAY、绝对客户区 x/y。未确认不采集。原生产 capture 固定640×360，不能靠此测试改变区域尺寸。若区域安全性变化，桌面 worker 必须停止测试并验证 FFmpeg 采集子进程结束；通过一次事前检查不代表能自动监测遮挡。

## 最小运行接口

SCREEN_E2E_CONFIRMATION 指向桌面 worker 在运行前写入的 JSON（模板不是确认，不可直接使用）：

    {"confirmed_test_window_only":true,"window_id":"实际ID","display":":0.0","x":80,"y":80,"width":640,"height":360,"selection":":0.0+80,80","pattern":"alternating-red-blue-1s","confirmed_unix_seconds":实际确认秒数}

确认有效期5分钟，测试启动与调用 Start 前各检查一次。run.py 另要求 SCREEN_E2E_CONFIRMATION_SHA256，防运行时替换确认。SURREAL_TEST_BINARY/SURREAL_TEST_SHA256、E2E_TEST_BINARY/E2E_TEST_SHA256 使用已核验固定本地 fork 和本轮编译 binary。

独立运行两 ignored 测试：
- enterprise_peer::enterprise_screen_e2e::authenticated_real_screen_capture_stop
- enterprise_peer::enterprise_screen_e2e::authenticated_revocation_closes_real_screen

每例必须看到真实 Screen Running 与对应完成 operation id、640×360 RGBA、序号增长、全区域至少99%像素满足红/蓝两相容差。第一例等待真实 Screen Stop 完成后关闭接收，第二例撤销成员后必须在显式 Peer.close **之前**看到两端自动 shutdown watch 与 FrameReceiver Closed。最终逐源 capture/playback 真实 Stopped、close 回执成功且不再收到新帧。未触碰摄像头或麦克风。FramePublisher 数据不是 GTK 呈现证明。

## 构建与证据

只源码改动，不开 Cargo。复用 r1 锁、native-client/target 和相同依赖/features，仅新的叶包。锁若解析改变须明确更新 source-receipt 的 lock条目并记录变化；不能将旧 binary 当新测试。源码预算低于1MB，构建需协调单窗口与磁盘守护。主工程未修改。
