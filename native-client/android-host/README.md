# Android 实验宿主与打包

此宿主保留NSH0.4 Rust-root模式，显式启用 `android-auto-update`，并引用更新与SAF的JNI初始化函数以保留动态导出。默认客户端/默认发布流水线不因此启用它。

## 已实际验证

- 云Linux、Rust1.99.1、NDK29：arm64-v8a和x86_64 release cdylib真实链接成功。
- 两ABI动态符号包含 `JNI_OnLoad`、NSH `Native_runRust`、`UpdaterInitProvider_initialize` 和 `DocumentInitProvider_initialize`。
- Android35真实bootclasspath + SDK `core-lambda-stubs.jar`、Java8目标、代码严格警告通过，再由D8生成新DEX。不能用 `-cp android.jar` 代替bootclasspath证明兼容性。
- aapt2重新编译manifest；SDK/原包资源表恢复资源名与flag，不猜theme或系统路径。
- 打包器解析真实DEX类表，拒绝与NSH原DEX重名；原资源、原DEX和其他非签名项逐字节保留。
- 原APK所有ABI必须一起替换；检测ELF架构及必需JNI动态导出。
- 使用既有debug测试key重签的APK通过apksigner与16KiB zipalign。

这些是构建和静态包验收，不能代替系统安装权限、自更新、自动重启、SAF用户操作或媒体通话验收。运行验收由独立模拟器检查报告记录，未通过前不声称已运行。

## 本地构建

在仓库根目录，环境中应已有Rust工具链、Android35 SDK、NDK29与Java编译器模块：

```
ANDROID_HOME=/absolute/android-sdk bash scripts/native-client/build-android-host.sh
```

默认输出 `native-client/target/{aarch64-linux-android,x86_64-linux-android}/release/libnsh.so`。离线构建，不安装SDK或依赖。脚本只消费已有工具链。

## APK封装

先由现有NSH发布命令生成基础APK，再运行以下显式实验步骤。基础APK资源、原DEX全部保留；其旧native库由刚构建的两ABI库替换。

```
python scripts/native-client/package-android-host.py \
  --enable-experimental-host \
  --input-apk "native-client/.nsh/out/Surreal Collaboration.apk" \
  --output-apk "native-client/android-host/build/SurrealCK-experimental.apk" \
  --sdk "$ANDROID_HOME" \
  --native-lib "arm64-v8a=$PWD/native-client/target/aarch64-linux-android/release/libnsh.so" \
  --native-lib "x86_64=$PWD/native-client/target/x86_64-linux-android/release/libnsh.so" \
  --java-source-dir native-updater-platform/android \
  --java-source-dir native-media-platform/android/src \
  --manifest-fragment native-updater-platform/android/manifest-fragment.xml \
  --manifest-fragment native-media-platform/android/documents-manifest.xml \
  --keystore-existing /absolute/existing-debug.keystore \
  --key-alias androiddebugkey --test-signing
```

不覆盖输出、不生成key、不安装设备、不授权系统设置。正式签名必须去掉 `--test-signing`，使用已经授权的既有keystore/alias，并从环境提供 `NSH_KEYSTORE_PASSWORD`；脚本不保存或打印密码。测试包不是正式发行身份，不能作为已部署更新服务。

## 宿主边界

- 非导出provider在NSH Activity前取得真实Application Context；未初始化时filesDir返回不可用，不猜 `/data/data`。
- 更新权限缺失明确返回 `SystemConsentRequired` 并保持启动门锁定，不自动打开设置或模拟用户点击。
- APK提交只表示请求已发出；系统要求确认或安装失败仍锁定，新进程仍需完整策略验证。
- SAF导入/导出必须由用户操作触发。导入有单文件/总缓存上限，终态只清理应用自身导入副本；不删除用户原文件。
- 编入NativeAudio/NativeVideo类并不代表媒体完整权限生命周期或网络音视频链路已接通。

测试：`python scripts/native-client/test_android_host.py`。

## 阶段五：默认关闭的原生媒体

`ANDROID_NATIVE_MEDIA=1 bash scripts/native-client/build-android-host.sh` 显式启用host的 `android-native-media` feature；默认仍关闭，不替代普通NSH APK。封装时在已有两个manifest片段之外加入 `--manifest-fragment native-media-platform/android/media-manifest.xml`，使用新名称 `SurrealCK-stage5-media-test-only.apk`，不能覆盖既有被测APK。

只使用既有已授权测试key。打包器要求媒体Provider、frame/state/error/closed全部JNI真实导出，Java以SDK bootclasspath严格编译并合并DEX。完整行为与局限见 `../../native-media-platform/android/MEDIA-HOST.md`。没有设备采集、播放或两机通话验收前，不能把这份实验包称为功能通过。
