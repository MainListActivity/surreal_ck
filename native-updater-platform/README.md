# 平台自动更新接入（实验源码，未接通宿主）

## 当前真实状态

此目录提供独立实现和 macOS 可选宿主桥，默认禁用，尚未进入已验证安装包。现有客户端没有因此获得已验收的 macOS/Windows/Android 自动更新能力。缺失桥时必须继续失败锁定，不能跳过更新，也不能把 `PlatformInstallerStarted` 当作 `Ready`。

- Linux 云机：Rust 8 项测试、fmt、clippy 严格检查通过。Android 三个 Java 类以 JDK 21 的编译器模块和真实 API 35 android.jar、`-Xlint:all -Werror` 编译通过。
- macOS：Objective-C/Sparkle 源码、Rust/C主队列桥、opt-in构建及框架嵌入脚本已写，尚未取得并链接 Sparkle SDK，没有 macOS 编译、签名安装或重启实测。
- Windows：PowerShell/Inno 启动代码已写，没有 PowerShell 解析和真实 Windows 执行记录。
- Android：JNI桥已通过NDK29真实aarch64-linux-android cargo check，非导出ContentProvider注入真实Context，不替换NSH JNI_OnLoad。实验宿主现已完成manifest/dex合并和双ABI真实链接，测试签名APK通过包结构/签名/对齐核验；仍未在已签名新旧APK间运行安装会话或验证重启。
- 未发布、未创建凭据、未触发 Actions、未更改安全设置。

## 不可绕过的顺序

1. `native-updater::runtime::run_startup_with_installer` 验证策略 Ed25519、时效、版本、防回滚持久状态及资产大小/SHA256。
2. 安装回调内使用 `InstallRequest::from_verified_policy` 再校验内容和发布者格式。此构造器**不验证策略**，不可供网络/JS直接调用。此类型不是不可伪造的安全能力。
3. 平台检查发行身份、安装并管理旧进程生命周期；旧客户端始终锁定。
4. 只有新进程重新执行完整启动门返回 `Ready` 后才能开放业务。

publisher 约定：macOS 为10位大写 Developer ID Team ID；Windows 为签名证书DER SHA256（不是常见SHA1 thumbprint）；Android 为APK签名证书DER SHA256。生产策略必须填真实身份，不可使用“unsigned/debug”等标签。

## macOS Sparkle

`CKStartRequiredUpdate` 在主线程、锁定页期间执行。自定义 standard user driver 自动接受下载与安装重启，不必让用户点击“安装并重启”。禁用Sparkle独立的自动检查/后台下载周期，每次由核心启动门发起；这样不会复用过时授权。保留系统自身授权提示，不以脚本绕过。

要求：宿主可写、签名 Team 匹配、Info.plist真实 HTTPS SUFeedURL 与32字节 SUPublicEDKey；Sparkle.framework及其XPC/Updater需按官方方式嵌入、签名、公证。合并 `Info-update.plist`，CFBundleVersion须与签名策略 version/appcast version一致。相同 Team 的更新包还要有 Sparkle Ed25519 签名。只允许策略指定 version+URL，不接受信息页和付费大版本。

已实现 `sparkle::start(&InstallRequest, generation, extern "C" status_callback)`：返回前复制bytes和字符串，异步切换mac主队列。`macos-sparkle` feature默认关闭，开启后build.rs强制真实 `SPARKLE_FRAMEWORK_DIR` 头文件并以ARC/严格警告编译、链接框架。`embed-framework.sh`消费已有核验SDK和已有签名身份，不下载、建密钥或发布。

内容绑定已实现：选中条目的 `enclosure.sparkle:edSignature` 必须用宿主SUPublicEDKey对**核心刚验证过SHA256的原始bytes**再次验签成功，同时version/URL/length精确匹配，delta和含delta候选一律拒绝。Sparkle自身随后使用同一公钥/签名验下载包，因此不同bytes不能通过。强制 `SUVerifyUpdateBeforeExtraction=true`，拒绝没有该设置的宿主。Rust测试覆盖不同归档、错公钥、错签名和错误长度；仍须真实Sparkle版本验证其全部调用路径，特别是恢复缓存会话的安装路径。

仍需完成：锁定并取得Sparkle发行版本/核验供应链；macOS编译链接与框架嵌入实测；客户端可选feature全链路实测；appcast生成/签名；确认Sparkle重定向及缓存恢复行为不会扩大核心网络规则。当前public delegate API没有显式重定向拒绝回调，HTTPS scheme配置不等于完整主机白名单。该差异未解决前不能作为生产验收完成。

回调ABI为 `(generation: u64, terminal: bool, text: *const c_char)`。宿主只在已验证installer回调内登记sender；同步失败RAII释放，完整Sparkle cycle结束后释放原生owner并发terminal。旧generation的迟到/重复回调被忽略；终态释放sender使UI可重试，不发Ready。5项Linux状态机测试已通过，但ObjC生命周期仍需macOS实测。

宿主建议：可选feature `macos-auto-update`转发平台crate `macos-sparkle`，仅macOS开启。核心安装回调构造InstallRequest，再调用sparkle::start；状态回调只复制字符串到Event::Status，绝不发送Ready。PlatformInstallerStarted仅代表已排入主队列，新版本仍需完整在线策略验证。

只读卷、其他用户拥有的应用、首次安装、系统授权提示和签名异常不能保证零点击。普通用户可写 `.app` 的后续更新可以做到自动下载安装及重启。

官方依据：https://sparkle-project.org/documentation/api-reference/Protocols/SPUUpdaterDelegate.html （willInstallUpdateOnQuit）及 https://sparkle-project.org/documentation/api-reference/Protocols/SPUUserDriver.html 。

## Windows

`Install-RequiredUpdate.ps1` 接收私有目录中的已验证安装器，持有禁止改写/删除的文件句柄，核验SHA256、Authenticode及证书DER SHA256，使用固定 Inno `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS` 参数。没有提权或 ExecutionPolicy bypass。

仍需完成：Rust启动此本机受信脚本的桥；每用户私有暂存目录ACL验证（目前仅LOCALAPPDATA路径限制不足以代替ACL）；安装器AppId/路径与旧版本保持一致；进程优雅关闭、Inno Restart Manager注册/自动重启验收。现有打包脚本 `[Run] skipifsilent` 不会主动启动新应用，不能仅凭本脚本就宣称新安装首次启动或所有升级都会重启。

## Android

`RequiredUpdater.privateDataDirectory(Context)` 使用真实filesDir，绝不猜 `/data/data`。安装会话复查内容、包名、精确版本及单个签名证书；将同一bytes写入PackageInstaller会话；使用非导出显式 receiver 和 mutable PendingIntent。会话失败会清理，提交不等于成功。

Android12+符合官方条件的自更新可以请求无交互安装，不应笼统断言所有Android都不支持。须声明两项manifest权限、拥有系统允许的安装来源权限，并满足不断提升的targetSDK条件。系统依然可以返回 `STATUS_PENDING_USER_ACTION`；当前receiver记录并保持锁定，不绕过也不自动点击。Android11及以下普通应用通常需要用户确认。后台启动限制也意味着安装成功后不可普遍保证自动重新打开UI。

JNI接口为 `android::private_data_dir()` / `android::start(&InstallRequest)`。非导出 `UpdaterInitProvider` 在Activity前载入libnsh并缓存真实Context、JavaVM和Java类，不替换NSH自己的JNI_OnLoad。安装APK的versionName必须等于策略版本，versionCode必须严格大于已安装值；整个APK已被策略SHA256绑定，不猜versionCode映射。

实验打包已落实：`native-client/android-host/`使用独立NSH0.4 Rust-root宿主；`scripts/native-client/package-android-host.py`消费基础APK，使用SDK工具重新编译合并manifest、附加DEX，并保持原资源/原DEX逐字节不变。更新/SAF JNI在双ABI的动态符号中实查存在。没有修改第三方CLI。

生产还需：两项权限的渠道合规审核、系统安装会话结果回传UI、真实设备新旧包升级/重启验收；没有权限时目前已明确显示系统安装授权需求并保持锁定。默认release不启用此实验宿主。详见 `../native-client/android-host/README.md`。普通权限下不尝试root、adb或辅助功能绕过。

官方条件：https://developer.android.com/reference/android/content/pm/PackageInstaller.SessionParams#setRequireUserAction(int)

## 云机验证命令

```
cargo test --manifest-path native-updater-platform/Cargo.toml --locked --offline
cargo clippy --manifest-path native-updater-platform/Cargo.toml --locked --offline --all-targets -- -D warnings
java com.sun.tools.javac.Main -Xlint:all -Werror -cp "$ANDROID_HOME/platforms/android-35/android.jar" -d native-updater-platform/build/android native-updater-platform/android/top/maplayer/collaboration/update/*.java
```

macOS/Windows原生安装、同签名升级、进程关闭与重启、损坏包、磁盘不足、拒绝授权必须由对应平台执行；编译/静态测试不能替代这些验证。
