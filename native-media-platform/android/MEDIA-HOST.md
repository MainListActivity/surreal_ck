# Android 原生媒体实验宿主

这是默认关闭的 `android-native-media` 实验实现，需独立宿主feature、media-manifest.xml、Java DEX及JNI一起打包。未改变第三方NSH AppActivity，使用非导出的 NativeCallActivity。普通客户端/普通APK不会自动启用。**编译与测试不代表真实摄像头、麦克风、屏幕或两机通话已验收。**

## 实际接线

- Provider在NSH启动前绑定真实Application Context/JavaVM。初始化不请求权限、不打开设备。
- Rust `begin()`同步准备单调session代数，`show()`仅在业务门禁后的显式用户点击打开原生控制。旧session的延迟show/start/frame/stop不能操作新peer。
- AndroidCall在SDP前附加静音VP8/Opus轨；Java编码回调经8MiB/64项有界Rust队列送Media::send；接收帧经有界Java执行队列进入真实MediaCodec Surface解码器或AudioTrack。
- 独立Activity列出实际Camera2设备；摄像头、麦克风、屏幕及远端音视频分别默认关闭，用户逐项开启。不会使用测试画面或合成音代替失败设备。
- CAMERA/RECORD_AUDIO及Android13+通知权限由系统界面请求。通知被禁用则拒绝采集。屏幕每次使用新MediaProjection系统同意token，先启动对应可见前台服务再创建Projection，不缓存同意、不自动点击。
- 前台通知有停止采集操作，服务非sticky；离开原生窗口/任务销毁停止采集与播放。系统权限/屏幕选择对话框期间保留其他已授权轨，取消屏幕选择不会关闭已有聊天或其他轨。

## 隐私与关闭约束

- 用户点击开启时就绑定source请求token。停止单轨/全部使尚在系统对话框或Service队列中的旧请求失效；回调不能重新生成授权。Service还验证控制Activity当前可见。
- Running来自真实视频编码输出或已验证AudioRecord.RECORDSTATE_RECORDING。Starting、Stopping、Stopped、Unconfirmed分开：停止请求立即禁发并清旧帧；Camera2等待onClosed、麦克风泵实际关闭资源后才报告Stopped。
- 权威快照和错误独立于帧队列，不因队列满丢失。构造或释放失败会逐项尝试剩余资源，并保留Unconfirmed owner，不因构造没返回对象就假报未占用设备。
- MediaCodec关闭放在自身handler，播放清理在有界worker而非UI线程。最终清理任务与清帧操作用短锁串行，迟到surface回调不能清掉关闭任务。播放释放未确认阻止整个session的Closed。
- 只有全部真实释放确认才允许新session；失败保留明显错误。不会通过清状态、重用token或隐藏通知来伪装成功。
- 网络关闭/错误/显式停止禁轨并请求宿主关闭；远端播放是用户单独许可。入队成功只表示接受处理，不表示画面已显示或声音已听到。

## 当前限制

- 本阶段是前台控制窗口模式；离开窗口会停止采集，因此不是跨应用持续后台屏幕共享产品。
- 编码固定640×480/15fps VP8，48kHz单声道Opus。硬件/codec不支持会失败；没有分辨率/码率自适应、完整AEC、抖动缓冲或音视频同步。
- 远端视频等待有效VP8关键帧、校验尺寸；队列丢帧后等待新的关键帧。当前无Java主动请求远端PLI的额外接口，恢复依赖网络现有PLI和编码器周期关键帧。
- AudioTrack非阻塞输出可能丢弃拥塞时未写出的PCM，不应宣称无损或高质量通话。
- 系统授予权限、媒体真实输出、Surface旋转/撤销/抢占、后台和两设备网络均需稳定设备验收。此前云API35纯软件模拟器出现system_server SIGABRT，旧APK只有一次安装通过，不能把该记录沿用到新媒体APK。

## 已运行的本地检查

- API35真实Android bootclasspath、Java8、`-Xlint:all,-options -Werror`编译全部Java。
- `scripts/test-android-host-pure.sh`：纯JVM验证停止使等待授权token失效、停止单轨不撤销其他轨、清理失败仍尝试全部资源且明确抛出未确认状态。不会执行Android stub或访问设备。
- Rust媒体包10项测试通过，其中3项验证session/权限/字节边界、队列满仍保留隐私快照、清旧帧和Unconfirmed不能关闭。
- Android aarch64/x86_64 Rust严格clippy通过；native-call的RTP回绕与Opus结构测试通过。
- 实验打包器依据media Provider声明要求全部真实JNI导出，不能仅靠DEX类名认定桥已存在。
