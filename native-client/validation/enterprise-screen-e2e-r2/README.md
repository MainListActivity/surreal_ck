# 企业真实Linux屏幕区域采集闭环

独立dot Xfce终端实际运行2个指定用例：2 passed，0 failed，15.08秒，TEST_EXIT=0、POST_HASH_EXIT=0。前后160项源码输入、实际窗口确认、测试二进制及固定fork摘要一致，FFmpeg摘要前后相同。生产源码和stage9 APK未修改。

## 已验证

仅使用预先确认的640×360原生测试窗口客户区（:0.0+80,80），每秒红/蓝交替，鼠标在区域外。没有全屏或其他内容采集。真实企业handle Start(Screen,明确区域)→原Call/CaptureInput::X11Screen→FFmpeg x11grab/libvpx→真实企业协商与OS UDP→原生VP8解码→原FramePublisher RGBA。

- 实际Screen Running及对应完成操作ID。
- 实际接收640×360 RGBA、递增帧序号与全区域至少99%像素符合红/蓝两相。
- 显式Stop后实际采集和播放停止。
- 成员撤销后，在显式Peer.close前已发生自动关闭，FrameReceiver Closed；逐源最终状态与close回执通过。
- 测试结束后桌面进程检查确认采集和测试进程已退出；随后关闭测试窗口，相关进程与窗口均消失。见desktop-cleanup.log。

本轮没有编码样本注入。原Peer文件仅附加测试模块，Call、采集、解码、FramePublisher均走原生产实现；bridge::Update仍为缩小的事件承载类型，故不是完整客户端UI点击流程验收。

## 仍未验证

没有摄像头、麦克风、扬声器、GTK接收窗口显示、macOS/Windows/Android硬件、多机公网TURN或生产身份验收。分享的是固定X11区域，不是窗口绑定式选择器，也不证明生产能自动检测遮挡或窗口移动。事前确认与受控测试环境不能替代持续区域保护。

固定fork为既有3.3.0-native-quota.1+sha.f30704bce914，仅本地合成夹具；业务以RECORD身份执行，root只用于本地夹具管理。生产更新门、账号注册与权限未更改。

## 证据

实际构建7.26秒、exit0，复用已有target，最低可用2,254,405,632 bytes。binary大小50,054,920，SHA256 28a4f534e2a61985ad7e4f5087db28f6d0b71c22ea99a1cd2eb5006c98654877。完整source/build及fresh确认回执见同目录。

原始harness在cloud工作区enterprise-signaling-screen-e2e-harness，入库日志仅去尾部多余空行。生成器/回执路径反映当次工作区；README-source-plan.md保留执行前计划，不扩大本报告的通过范围。未在本轮执行的67个过滤测试不计入通过数。
