# Android 实验宿主独立验收（2026-11-10 UTC）

## 固定被测产物

- `build/SurrealCK-ab2e3d99-verified-input.apk`，129,598,197 bytes。
- SHA256 `ab2e3d99acfc387bb51c59b3638c03846cd76a8de5d06fc1580ee3ef9a19b8a1`。
- 包名 `top.maplayer.collaboration`，versionName 0.1.0 / versionCode 1，minSdk 28 / targetSdk 35。
- 仅测试签名，不是生产发布。后续不同哈希产物不能继承本报告的运行结果。

## 通过：独立静态检查

`build/independent-static/` 保存原始输出。

- apksigner 验证 v3 签名成功，Android Debug 证书。
- zipalign 4字节及16KiB页对齐检查成功。
- 两ABI（arm64-v8a、x86_64）实际包含 `JNI_OnLoad`、更新与SAF Provider初始化JNI全局已定义符号。
- DEX包含更新、SAF及既有音视频Java适配类。
- 原NSH `classes.dex`、resources.arsc、res/、assets/逐字节保留。
- 新Provider、Receiver、DocumentActivity均不导出。权限为 INTERNET 及两项更新权限；未声明或授予摄像头、麦克风、媒体投影权限。

## 通过：一次真实模拟器安装

`build/device-verification-stable/`：

- 官方API35 x86_64 AVD，`-read-only -accel off` 纯软件TCG；无可用KVM。
- 约580秒启动，boot_completed=1；package/activity服务连续3次存在后才安装。
- `install.txt` 明确 `Success`，`install-status.txt` 为0。
- `package-after.txt` 返回该包的 `/data/app/.../base.apk`。
- `install-logcat.txt` 包含该APK x86_64 dexopt `status=PERFORMED`。

**仅确认安装成功，不能推导启动或功能通过。**

## 未通过验收：应用启动、屏幕与JNI实际调用

同轮启动请求返回 `Status: timeout` / `LaunchState: UNKNOWN`；随后进程查询超时。未取得有效应用截图、UI树、已运行Provider初始化或锁定页证据。

追加诊断轮 `build/device-verification-launch/` 在启动前遭遇模拟器Android系统服务故障：

- 已完成boot并确认package/activity服务存在，推送APK成功。
- 安装返回 `cmd: Failure calling service package: Broken pipe (32)`，随后 `Can't find service: package`。
- `install-logcat.txt` 记录 `system_server` PID1450 `Fatal signal 6 (SIGABRT)` 和 `Runtime aborting`，另有Bluetooth进程崩溃、Watchdog等待与系统栈回溯超时。
- 这轮没有应用启动证据，不能把系统崩溃归因于应用JNI，也不能把启动超时解释成应用正常。

更早只等120秒的模拟器检查不充分；实际冷启动需要约7.4至11.4分钟。APK安装120秒限时也曾超时，后来延长且改显式推送安装后得到成功。验收脚本现等待真实系统服务就绪，安装最多600秒，且使用不可变脚本副本避免运行时改写。

## 尚需稳定设备完成

- 首次启动/强制更新锁定页、Provider初始化、缺桥与异常状态。
- SAF选择/取消、重复选择与缓存清理、256MiB单文件和512MiB总上限、接收至应用文件区后独立导出。
- 相同签名新旧APK升级、系统同意分支、重启后重新验证策略。
- 媒体权限/前台服务/Surface全链路尚未实现；类存在DEX不表示摄像头/通话可用。

未执行真实自动更新，未授予安装来源权限，未使用root、辅助功能或修改安全设置。实验AVD均为只读实例并已关闭。当前运行验收应标为“安装通过；启动与功能未验收，受不稳定纯软件模拟器阻塞”。

## 阶段五：媒体宿主独立验收（按哈希分别记录）

### c936aad378916ff0edca7bfa758ae4c90d93f8961a03f02bf70eadf0e303a569

`build/SurrealCK-stage5-media-test-only.apk`，131,887,861 bytes；源码快照对应92c8e6e及`build/stage5-source-receipt.json`的80项输入哈希。

- 双ABI release链接、全部媒体JNI动态导出、MediaBridge/Activity/Service等实际DEX、非导出组件、foregroundServiceType camera|microphone|mediaProjection、调试签名和16KiB对齐均通过。独立检查输出在`build/stage5-static/`。
- 新建AVD因官方最低数据分区容量超过剩余磁盘，在安装前失败；未把此结果算作APK失败。后改用既有测试AVD有效数据镜像的只读副本，单CPU、256MB Java heap，未修改任何安全配置或启动KVM。
- `build/device-verification-stage5-clone/`记录实际冷启动497468ms，boot_completed=1且package/activity服务连续3轮存在。
- **实际安装通过**：install.txt为Success，install-status.txt=0，package-after.txt返回该包base.apk，系统dexopt成功。
- **启动仍未验收**：发送AppActivity启动后，模拟器宿主日志报告 `detected a hanging thread 'QEMU2 CPU0 thread'. No response for 15768 ms`，随后emulator进程Aborted、ADB设备消失。launch-status.txt=124，screen.png为0字节，无有效截图/UI树，无MediaProvider初始化成功日志。
- 因模拟器本身崩溃，不能据此认定应用JNI崩溃，也不能认定JNI/权限/前台服务/Surface功能运行通过。已结束此轮，未继续无界冷启动。

### 4a2c491d5974545f3de4deef08641ecaf9caf8b7fc73c28377641f8267cb23b8

`build/SurrealCK-stage5-media-r2-test-only.apk`；相对c936唯一生产源码差异是NativeCallActivity重开窗口时，若仍有采集owner则明确提示“前次采集尚未确认停止”，不误写尚未采集。来源记录在`build/stage5-r2-source-receipt.json`。

- Java严格编译、纯测试、完整静态打包验证通过。
- **没有安装或启动此哈希**，不能继承c936的安装结果。

### 可验证负例与未运行项

纯JVM五项真实状态/清理测试通过：系统授权等待期间停止使旧token失效；停止单轨保留其他轨token；重复请求不恢复旧token；多个资源释放异常仍尝试每个不同资源并保持未确认；正常释放不伪造失败。测试不调用Android stub、不授予权限、不访问设备；测试文件不进入APK。

摄像头/麦克风/MediaProjection真实授权与拒绝、前台服务通知停止、Surface输出、SAF选择/取消/旋转/超限、两设备协作仍为**未执行**。没有绕过强制更新门或登录门、没有自动批准权限，也没有以静态或纯函数测试冒充系统UI流程验收。

### 7100c0a 后续源码检查（未重打 APK）

- 复用现有 NDK/cache 和 `native-client/target`，以 release profile 对实验媒体宿主执行双 ABI `cargo check --locked --offline --features android-native-media`；这是源码交叉检查，不是新链接或设备执行。
- 实际 SDK bootclasspath 的 Java 严格编译通过；5 个采集许可 generation/资源清理纯测试通过。新增 SAF 生命周期纯测试覆盖最终销毁取消、配置重建不取消、重复结果拒绝及复制已接管后销毁不误取消。
- 源码审计发现并修复：DocumentActivity 在尚无选择结果时最终销毁，没有通知 bridge，可能永久占用唯一 active 请求。新增生命周期所有权状态，仅非配置重建且尚未接管结果时报告 cancelled。后台 provider 复制仍负责自己的最终结果。进程被 OS 直接杀死不保证调用 onDestroy，新进程的 bridge 也是全新状态。
- PackageInstaller 源码拒绝路径在创建 session 前检查系统安装许可；未提交 session 会 abandon；系统等待许可/失败不会解锁旧版。NativeCall 权限拒绝不会进入设备启动，销毁会请求停止并等播放释放回报。这些是源码审计，不是权限对话框或 Activity/Service 真机集成测试。
- 未再次冷启动不稳定 QEMU，未自动授权、未绕过更新门，未安装或重新打包。旧 r2 APK 不包含本次 SAF 修复，不能把源码测试移用为旧 APK 的运行结果。
- 双 ABI 检查实际成功，耗时 aarch64 45.05 秒、x86_64 45.56 秒。x86_64 期间并行客户端编辑新增 experimental-macos-video/windows-video cfg，Cargo feature 尚未同步时出现 4 条 unexpected_cfgs 警告；已报告客户端负责人，不声称该轮 Rust 严格无警告通过。检查期间有并行源变更，因此此结果仅代表当次编译输入，不作为不可变 HEAD 或旧 APK 的 receipt。

### 冻结源码增量严格复验

客户端与平台负责人确认功能/依赖冻结后，重新执行离线 aarch64 宿主 release check（2.10 秒），再执行 aarch64 和 x86_64 宿主 `cargo clippy --release --locked --offline --features android-native-media -- -D warnings`（0.32 秒、2.09 秒），均成功，没有前轮 cfg 警告。host Cargo.lock 仅同步 updater-platform 对已锁定 serde、serde_json、sha2、windows-sys 0.61.2 的四项依赖边，无新增包或版本。复用原 target，未链接新 APK，旧包运行验收范围不变。

### Stage 6：冻结源码 8e2c43e 的新测试安装包

- 文件：`build/SurrealCK-stage6-8e2c43e-test-only.apk`，131,879,669 字节。
- SHA256：`1da56a09213e7b51f60767eed14cf8802f28b727f165fc1c79ed2d46c138b462`。
- `build/stage6-source-receipt.json` 绑定完整提交 `8e2c43ef922a41f99f16f1d2ac5fbffbe31eb3e6`，构建前后1769个跟踪输入hash一致。双ABI实际release链接（17.07/16.43秒）、真实SDK严格Java编译和媒体/SAF纯测试通过。
- 独立静态复验：真实DEX包含DocumentLifetime和媒体Activity/Service；manifest私有组件及FGS类型0xe0正确；包内两ABI的so与链接产物逐字节一致，媒体/SAF/更新JNI实际GLOBAL导出；apksigner v3和16KiB zipalign通过。证据在 `build/stage6-static/` 及 `stage6-link.log`、`stage6-java-test.log`、`stage6-packaging.log`。
- 仍使用既有测试签名，**未安装或启动这个hash**，不能继承c936或ab2e3d99的安装结果。缺生产更新信任配置仍保持锁定，不是可供正式使用的Release。


## Stage 7：冻结源码1903111的媒体与OAuth实验包

`SurrealCK-stage7-1903111-media-oauth-test-only.apk`，131,908,341字节，SHA256 `9a8251c74041959ab2b95f04f8dbfa7e0bc8d3073fa3fc10b1d17cba4d898fe3`。源码 `1903111d2da33491d72762db59cc7c17e3829d9a`，构建前后跟踪输入一致，最终git status为空。双ABI实际release链接、SDK严格Java、媒体/SAF/OAuth纯负例、9项打包器测试、实际DEX/JNI/manifest、v3验签和16KiB对齐均通过。父工程师另行复算APK SHA256一致。

尚未安装或启动；无生产OIDC/trust配置；没有远端登记或登录。只能作为静态与构建验证，不继承c936或其他APK的设备结论。证据与source receipt位于独立 `build/stage7-*`，旧包未覆盖。
