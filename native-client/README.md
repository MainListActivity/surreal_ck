# 吉吉原生协作客户端（开发中）

NSH 0.4.0 + Rust 原生界面，不使用 WebView。独立 Cargo workspace，不改变既有 Web 应用。

## 最新打包状态（2026-11-11）

正式打包脚本现在显式构建企业信令/媒体/文件与平台 updater，而不是仅交付 NSH 默认 runner：Android 合并实际 updater/SAF/OAuth/media DEX、manifest 和双 ABI host；Windows/macOS 使用手写 `src/main.rs`。Cargo 默认 features 仍为空，直接运行 `nsh package` 不是完整协同安装器流程。

提交 `079aed6` 的 Android 与 Windows 完整协同入口安装包已通过真实 CI 构建和最终包静态校验；macOS 两架构的企业/updater 原生验证通过，但正式 DMG 因缺生产更新公钥/feed/Developer ID 配置停止。每份最终包附独立内容证据，静态通过不等于安装或功能验收，也不消除下述媒体运行时缺口。

提交 `bfb036c` 的 macOS 两架构与 Windows 原生安全接收候选探针已全部通过，Windows 额外三项 symlink 攻击也实际执行通过。候选探针不等于完整传输验收；新增真实 Transfer/子进程中断检查仍须在原生 CI 运行，生产接收开关继续关闭。

仍未完成：生产原生身份/更新服务配置；桌面媒体运行时可信供应链与实际合格输入（打包脚本已接入固定清单验证/复制）；Windows/macOS安全接收全部原生验收；真实登录、会议/屏幕/文件和升级重启测试。最新本地 Android 模拟器安装期间被系统终止，安装结果未知，不把它归为 APK 崩溃或安装成功。已增加 Android/Windows 隔离 CI 安装/启动 smoke 路径，不授予权限或绕过更新门，其结果必须单独等待。

下文保留开发阶段的历史边界和证据，涉及“默认包/实验宿主”的旧描述以本节和实际打包脚本为准。完整包目标尚未交付。

## 当前可验证内容

- 原生启动更新门禁；没有生产更新信任根和服务配置时强制锁定，不创建业务会话。
- 协作组件接入真实 WebRTC 数据通道：手工邀请/应答、复制连接码、中文消息、错误状态、关闭连接。
- 未内置公网服务或凭据；用户可显式填写STUN，直连失败后手动选择自己的TURN配置重建连接。对端包含relay候选时标明路径待核验，不把候选当作已选中路径；公网互通仍未验证。
- 不把通道成功写入称作对方已收到/已读。失败时保留消息输入；内存列表上限1000条。
- 桌面文件UI已接入真实流式协议：选择后确认发送、接收方选择新路径/拒绝、进度、取消、SHA256与原子无覆盖落盘、最终ACK。Android默认包仍禁用文件桥；显式实验宿主已打包SAF，运行验收尚未完成。
- 企业身份UI已接入系统浏览器/桌面受限loopback、真实验签和当前工作区只读成员；需要已注册原生回调与正确客户端配置，可显式选择public PKCE discovery模式。工作区切换只在用户点击后执行，完整验证和成员读取成功才替换会话。当前未配置、不声称生产登录成功；成员目录未与手工P2P身份绑定，没有消息历史同步。
- 桌面媒体接线正在验证：每次显式选择设备后启动原生FFmpeg采集，通过WebRTC发送；接收音频/视频分别确认。Linux使用GTK原生RGBA视图；macOS/Windows有默认关闭的实验宿主接线，尚未通过目标平台运行验收。默认Android包不启用媒体；阶段五实验宿主已打包，但设备验收未通过。真实设备、两机网络与GUI仍待验收，不用合成数据测试代替。
- 设计参考与原图：../docs/design/collaboration-client-v1。当前原生UI仍为功能验证布局，不是设计最终还原。

## 企业会话实验整合（2026-11-11）

`experimental-enterprise-media,experimental-enterprise-files` 显式启用组织信令会话中的媒体和文件入口，默认构建不启用。媒体在SDP之前挂接但默认不采集、不播放；只有用户明确操作后启动。停止/隐私区不随账户设置折叠消失，切身份和停止聊天先同步禁止新操作，再等待真实清理。逐源采集、播放、会话代次与操作ID控制最终回执，旧Stop回执不能清除新Start待确认状态。

企业文件使用同一授权会话的数据通道，接收需显式确认新位置。退出、成员撤销、断线会停止新传输并等待清理；已保存事实单独保留，取消不承诺对端未保存。回执仅显示给原身份代次；Android企业接收保存在私有区，导出仍禁用。macOS/Windows安全接收和真实设备流程未获本轮验证。

本轮完整客户端103单测与6个Headless界面用例通过，包含真实媒体控制对象的停止协议和文件UI生命周期负例，但不是生产登录、真实摄像头/麦克风、Android设备或公网TURN验收。既有真实同机UDP企业文字证据单独保留；新增真实OS UDP文件闭环2/2已通过（本地RECORD/API夹具、显式确认、保存SHA/ACK和撤销保留账本），不是生产或公网验收。另有独立合成VP8企业媒体闭环2/2通过：真实OS UDP、原生解码、FramePublisher RGBA与撤销自动关闭；测试注入绕过设备采集，没有GTK显示或硬件验收。生产更新门、身份配置及发布前提不变。

## 本地验证

Rust 1.97+，建议使用固定工具链。NSH CLI 0.4.0。

```sh
cargo test --manifest-path native-client/Cargo.toml --lib --tests
cargo clippy --manifest-path native-client/Cargo.toml --lib --tests -- -D warnings
cargo run --manifest-path native-client/Cargo.toml --features desktop
```

Linux原生构建需要GTK >=4.14、GStreamer开发库和平台编译工具。desktop feature 只用于桌面binary；接入原生视频组件后，Linux测试也需要上述GTK开发库。NSH原生根App对Android可直接由NSH打包，无需desktop feature。

```sh
cd native-client
nsh package --target android --abi arm64-v8a,x86_64
```

Android默认本地测试签名不能当作正式发布身份，必须明确标注。macOS/Windows由相应平台CI构建，Windows需要额外安装器。

## 必须完成的发布门

启动已接入 native-updater 的真实 HTTPS 策略读取、签名校验、原子状态保存、Linux 安装和进程重启接口；只有 Ready 结果才挂载协作界面。构建变量 SURREAL_UPDATE_CONFIG_JSON 只能嵌入公开信任配置，不能包含私钥。尚无生产公钥与端点，当前包保持锁定。macOS/Windows安装桥尚未完成平台验收；Android实验宿主已通过JNI安全取得 Context.filesDir 并打包PackageInstaller桥，但实际升级验收仍待完成。没有绕过开关，不得把包安装成功等同于业务可用。

Linux桌面已编译；初版headless模型/门禁/协作UI测试通过。GUI窗口受当前云机socket能力限制；Android交叉构建和模拟器验证以最新运行报告为准，未完成不标通过。

品牌图 assets/brand.svg 由 scripts/export-brand.py 从仓库原有 Logo.svelte 精确导出几何与配色，不使用生成式近似 Logo。

## 阶段二身份与平台配置

客户端只从编译环境固化公开身份端点（SURREAL_CK_OIDC_ISSUER、SURREAL_CK_API_BASE_URL、SURREAL_CK_OIDC_CLIENT_ID、SURREAL_CK_OIDC_AUDIENCE、SURREAL_CK_NATIVE_REDIRECT_URI、SURREAL_CK_SURREAL_URL、SURREAL_CK_SURREAL_NS）。不得填入client secret。身份令牌只在应用后台内存存在，退出登录或关闭应用会丢弃，折叠面板不会退出；不会写文件/日志。Android自定义scheme身份回调已接入默认关闭的实验宿主，候选回调尚未获生产注册或设备登录验收。详细协议与注册阻塞见 ../native-identity/README.md。

macos-auto-update为默认关闭的实验feature。启用需要真实Sparkle SDK、相应平台构建与正确签名清单；本地Linux编译不代表macOS桥已验证。默认发行包不启用Android桥；下面的实验宿主显式打包后才启用。

## 阶段三 Android 实验宿主

`android-host/` 与 `scripts/native-client/build-android-host.sh`、`package-android-host.py` 提供显式实验构建：把更新与 SAF Java、manifest 组件和真实双 ABI JNI 库加入 APK，保留原 NSH 资源。需要现有签名 key 和 `--enable-experimental-host`，默认 Release 流程不启用它。

启用且宿主初始化成功时：发送先由 SAF 导入 app 自有缓存（单文件256MiB、总缓存512MiB上限），用户再确认发送。接收按钮明确保存到应用私有文件区，完整校验落盘后才确认对端；导出到系统文档位置是另一个用户操作。仅释放自有导入副本，不删除用户原始文档。缺更新安装来源授权时明确提示并保持锁定，不跳设置或代点许可。

实验APK已完成DEX/manifest、JNI双ABI、资源保留、签名和16KiB对齐检查；模拟器已实际启动并确认PackageManager/Activity服务就绪；固定SHA256 ab2e3d99… 的实验APK已获得真实安装Success、pm路径与系统dexopt证据；启动命令超时且后续模拟器发生系统崩溃，未得到有效Activity/截图或交互验收；已停止重复冷启动。此状态不能替代SAF交互、PackageInstaller升级、设备媒体采集的实机验收。网络/配置失败可以重新检查更新，每次都重新完整验证，不存在绕过按钮。

## 阶段四桌面媒体边界

所有采集和接收默认关闭，打开设置不会触发设备。隐私状态与停止按钮不随设置折叠隐藏；关闭未获确认时保留警告，不能用普通断线信息覆盖。视频仅发布真实解码帧到有界最新帧缓冲，不经过WebView、PNG或JSON像素传输。停止视频或更换会话清除旧画面并创建新流ID。

目前依赖本机FFmpeg/ffplay，不包含可交付的完整桌面媒体运行时。Linux屏幕仅支持显式X11区域（640×360、15fps），Wayland portal与系统窗口选择器未实现；macOS/Windows采集入口尚无目标设备实测。没有自动打开摄像头、麦克风或播放远端音频，也没有声称当前APK支持媒体采集。

媒体会话的真实FFmpeg编码、虚拟网络ICE/DTLS/SRTP、解码回调测试与GTK原生组件编译已通过。这不代表公网、声画同步、系统权限或可见窗口验收通过。所有业务仍受真实生产更新门禁约束。

## 阶段五可选链路

- 原生public-client登录通过编译配置 `SURREAL_CK_OIDC_TOKEN_MODE=public-pkce-discovery` 和 `SURREAL_CK_OIDC_ALLOWED_HOSTS` 精确主机白名单显式启用；默认仍为既有proxy。严格验证discovery的issuer、HTTPS443、端点host、PKCE和签名算法，不跟随重定向、不降级、不保存refresh token。真实client登记和线上联调仍未完成。
- 原生UI提供真实工作区列表和显式切换。失败保留原已验证会话和成员，过期/退出会清除；不自动取第一个工作区。
- ICE高级设置不默认选择服务；TURN密码遮罩且只留内存，Debug脱敏。手动中继回退重新交换连接码，不静默切路。当前不支持stuns:，明确拒绝而非降级。
- `android-native-media` 默认关闭，仅供同时打包MediaProvider/Activity/前台服务/JNI的实验宿主。进入通话页不自动采集或播放；Starting、Stopping、Running、Unconfirmed各自保留真实状态。停止全部媒体与聊天断开不同，未确认释放禁止替换会话。新媒体宿主已产出test-only APK，hash与静态检查见 android-host/STAGE5-MEDIA-VALIDATION.md；设备证据单独绑定新APK，不继承阶段三旧APK安装结果。
- macOS AppKit与Windows Direct2D后端在独立crate有默认关闭的实验feature；其真实绘制API静态目标检查不等于完整NSH平台链接或GUI验收，客户端默认仍仅启用Linux视频视图。

阶段五Linux客户端35项单元测试和4项Headless交互测试通过，严格clippy通过；包括配置脱敏、显式中继回退、工作区切换回滚、迟到结果拒绝与可滚动设置/常驻停止动作。Android媒体实际权限、硬件、前台服务和Surface仍待稳定设备验收。


## 默认关闭的桌面实验视频宿主

仅在对应原生开发环境显式使用 `--features desktop,experimental-macos-video` 或 `--features desktop,experimental-windows-video`。它们同时连接原生根注册、手写入口注册和视频能力门闩，界面显示实验未验收提示；仅开启依赖后端 feature 不会误启用客户端视频。默认构建和 Release 不启用这两个 feature。仍需要本平台完整编译、真实窗口/帧、权限与运行时验收，不能把跨平台类型检查称为可用产品。

Android SAF 最终销毁取消的后续源码修复尚未重打入已有 APK；c936/r2 的具体证据和来源以 `android-host/DEVICE-VALIDATION.md` 为准。

## Windows 更新宿主实验入口

`windows-auto-update` 默认关闭，必须使用包含本仓库 `src/main.rs` 的桌面入口。入口在 NSH 初始化前处理固定 helper 模式；生成的 NSH runner 没有该入口，平台桥会明确拒绝，不能作为已支持自动更新的包发布。核心签名策略与下载 hash 通过后，原生 helper 校验私有目录 ACL、重解析点、安装器及当前程序的 Authenticode 证书 SHA256；握手完成且业务尚未挂载时退出旧进程。新进程仍重新经过更新门禁，交接成功不等于安装成功或 Ready。

此实现尚无完整 Windows 客户端原生链接、ACL/WinTrust/Inno/重启系统验收；未签名预览程序不能通过此桥。目标 API 原样源码检查和协议负例不替代真实系统验证。详细限制见 `../native-updater-platform/windows/NATIVE-HOST.md`。
