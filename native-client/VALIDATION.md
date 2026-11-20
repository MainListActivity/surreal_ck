# 原生协作阶段验证记录

2026-11-10，dot Linux 云工作区。记录只描述实际跑过的检查。

- 客户端6测试通过（4模型/桥接，2原生headless UI）；clippy `-D warnings`通过。
- Linux GTK原生 desktop binary 构建通过。宿主Xvfb本地socket不可用，未取得桌面窗口截图。
- Android官方SDK35、NDK29.0.14206865，NSH0.4.0：arm64-v8a及x86_64原生APK已打包，apksigner verify通过，签名为Android Debug，仅限明确标注的测试构建。
- Android emulator37.2.13，API35 x86_64系统镜像，软件渲染/无KVM：ADB从offline转device，但等待期间没有boot_completed=1；未完成APK安装/启动/截图验证。
- native-updater：20安全测试、15运行测试通过，其中本机真实TCP下载、Linux ELF安装和exec版本1.0.0到2.0.0切换；该集成用测试签名与本机测试传输，不能替代生产HTTPS策略部署。
- native-transport：7测试通过、1真实OS网络测试明确跳过。虚拟网络上真实ICE/DTLS/SCTP中文消息、文件hash及真实编码Opus/VP8三轨验证通过。云OS无可枚举网卡，不能据此声称公网P2P通过。
- 发布资产收集和更新策略脚本4测试通过；macOS/Windows Actions尚待实际运行。

## 当前不可宣称完成

生产更新信任配置及部署尚缺。入口按要求fail closed，不允许越过更新。视频设备采集、屏幕共享设备、原生视频解码/纹理渲染、Android文件选择/存储桥、真实企业登录配置与消息同步、三端正式更新安装桥和完整设计还原仍未完成。桌面文件UI与身份验证接口的阶段二进展见下。现有邀请码需人工交换、没有内置公共TURN；不是可用会议产品。

设计原图、说明和提示词已从已授权Mac导出包校验SHA256后导入 `docs/design/collaboration-client-v1`。品牌SVG精确复用仓库原有Logo几何。

## 阶段二增量

- 客户端8项headless/桥接测试通过，包括文件接收必须确认与企业配置缺失不成功。严格clippy通过（后续改动需持续回归）。
- 文件会话新增真实虚拟WebRTC网络上的批准/拒绝、取消/断开、损坏hash、目标竞争不覆盖和最终ACK用例。网络测试不等于公网实机测试。
- 企业身份核心包含真实本机TCP回调、测试签名JWT/JWKS、换票/工作区HTTP与成员WSS协议测试。没有执行生产登录/成员读取或IdP注册。
- Sparkle/macOS和Android平台源码仍是默认关闭或未接宿主的实验范围，不以编译通过冒充安装验收。

阶段二统一回归：check-rust.sh 实跑六crate，83项通过、真实OS网络1项跳过；全部fmt/clippy通过。Linux desktop再构建通过。Android更新3个Java类和媒体2个Java类均以本机JDK21编译器模块、Android35 API、-Xlint:all -Werror复验通过。双ABI APK重打成功；这些Java源码仍未加入NSH宿主dex，不代表APK已有平台更新/媒体设备能力。

## 阶段三增量

Android实验宿主输入APK `SurrealCK-android-host-final.apk` SHA256 为 `ab2e3d99acfc387bb51c59b3638c03846cd76a8de5d06fc1580ee3ef9a19b8a1`，独立验收持有固定副本。该包静态检查通过，当前不把它记为安装/启动通过。其后原生布局和更新重试UI另有源码改动，不能将此旧哈希称为所有最新源码产物。

更新测试夹具偶发TCP RST已定位为服务端单次read未完整读取请求头；改为有界完整header读取后，真实下载/安装/exec用例连续10轮及35项更新全测通过。没有跳过该用例或改为mock。

## 2026-11-10：取消、重试与原生注册回归

- 客户端 42 个单元测试、4 个 headless UI 测试和 `clippy --all-targets -D warnings` 通过。修复重新启用视频时的旧事件屏障、可靠播放配置确认，并将远端播放失败与本机采集关闭状态分离。
- 桌面通话先复现取消停止/取消允许播放的失败负例，再修复取消守卫、关闭失败闩锁和两阶段接收配置；20 项测试及严格 clippy 通过。测试包括真实 FFmpeg 编解码与虚拟网络 WebRTC，不是设备或公网实测。
- Sparkle 回调使用每次尝试的 generation 和明确终态释放 sender；检查失败后可重试，迟到回调不污染新尝试。5 项生命周期测试已在完整客户端测试中通过。macOS ObjC/Sparkle 原生编译、安装仍未验证，feature 默认关闭。
- Linux 真实 NSH 注册契约 3 项通过，不创建窗口。macOS/Windows 绘制适配保持实验关闭，不能从 Linux 注册测试推断目标平台可运行。
- Linux 原生可执行文件 `target/debug/surreal-collaboration` 已重新构建，SHA256 `69234483540b59d80f837f9ab728e40379a574c6c58776247275a51b4d9dcc27`。未进行 GUI 验收；缺可信更新配置时保持启动锁定。
- Android 媒体测试包 `c936aad378916ff0edca7bfa758ae4c90d93f8961a03f02bf70eadf0e303a569` 已有真实安装成功、包路径和 dexopt 证据；启动阶段云端 QEMU 挂起后退出，无有效截图或媒体 JNI 运行通过证据。r2 包 `4a2c491d5974545f3de4deef08641ecaf9caf8b7fc73c28377641f8267cb23b8` 未安装。本节客户端源码修复没有重打这两个 APK，不得把它们重新标记为本次源码产物。详见 android-host/DEVICE-VALIDATION.md。
- 认证信令仍禁用：完整 cloud/executor 技能目录与仓库注册清单均未提供 AGENTS 要求的 surrealql 技能；没有新建 SQL、生产授权或数据访问。

## 后续同会话与实验平台接线

- 同一对虚拟网 WebRTC Peer 的双向中文聊天、显式文件接受、6 块数据与 SHA-256/损坏拒收、三条 SRTP 轨、双视频真实 RGBA 解码通过。文件 ACK 与容量1事件队列背压期间，独立媒体 stop 三次为 4.57/5.21/6.79ms；恢复事件消费后取消完成且无 `.part` 残留。这不是公网或真实设备/扬声器验收。
- 该测试先发现关闭 Peer 后底层媒体 sample 写入仍返回 Ok，已补连接状态前后检查并验证关闭后拒绝；新增未连接/关闭后的三轨发送负例通过。
- 客户端文件操作移到容量8的独立命令任务，主 actor 不再 await 文件 hash/取消通知；文件输出背压隔离与重复停止测试通过。该测试不声称在UI完全停止消费所有消息时仍可持续操作全部控件。
- 客户端本轮 43 单元 +4 headless UI 测试及严格 clippy 通过。Linux同时启用两桌面实验flag的目标隔离回归通过，不等于macOS/Windows原生编译。
- macOS/Windows实验视频需客户端显式feature、目标后端、experimental-host门闩及两个入口注册一致，默认发布不启用。Windows更新helper仅有目标API检查和协议测试，尚无真实系统安装/重启结果，默认关闭。
