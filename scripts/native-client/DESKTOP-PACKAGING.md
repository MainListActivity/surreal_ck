# 桌面协同安装器接线与验收边界

`package-windows.ps1` 和 `package.sh macos` 使用 `build-desktop-app.py`，不再将 NSH 默认生成 runner 当作协同应用。构建器只接受对应 native Rust host，使用 locked release、显式企业信令（由 media/files feature 传递）、媒体、文件、平台 renderer 和平台 updater。Cargo JSON 必须唯一匹配 `native-client/src/main.rs` 的 release bin 及全部必要 features。Windows 安装器快捷方式、启动项和 updater helper 指向同一 `surreal-collaboration.exe`。

公开身份与更新配置沿用原验证路径；缺配置仍锁定，不注入认证状态或放宽更新门。`desktop-package-evidence.json` 记录源码/公开配置摘要、features、手写入口、编译及签名后文件 hash。总安装器 receipt 同时覆盖 native-signaling 源码。这些只是构建与静态包证据，始终标记运行未验收、非 release eligible。

## macOS 必需输入

- 编译：原生 macOS Rust 工具链、Xcode/clang 和事先核验来源/摘要的本地 Sparkle SDK；`SPARKLE_FRAMEWORK_DIR` 为含 `Sparkle.framework` 的绝对目录，必须包含 `Headers/Sparkle.h`。正式构建器启用 `macos-auto-update`，并给最终 bin 设置 `@executable_path/../Frameworks` rpath。
- 打包：上述 SDK 以及 `SPARKLE_EXPECTED_VERSION`、既有 `SPARKLE_PUBLIC_ED_KEY`、HTTPS `SPARKLE_FEED_URL` 和现有 `MACOS_SIGN_IDENTITY`。正式构建器提前检查必填项；既有 `embed-framework.sh` 校验版本、公钥、feed，复制框架及嵌套 XPC/helper，设置强制验签 plist，并从内到外签名。缺项即失败，不回退到不含 updater 的包。
- 公证：可选既有 `APPLE_NOTARY_PROFILE`；未提供时只能报告 Developer ID 已签名、未公证，不能称为已通过 Gatekeeper。脚本不创建任何身份、密钥或凭据，不下载 SDK，不发布 Release。

这些输入不要求在无 SDK 的 dev CI 伪造：该 CI 可继续独立的 fixture 回归、preview 编译以及其他平台验证，但不能将 preview 替代正式 macOS 安装器。

开发 CI 通过 `install-sparkle-sdk.py` 获取官方 Sparkle 2.10.1 SDK，固定 SHA256 为 `1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27`（官方 GitHub Release asset digest），校验后才解包并核对 framework 版本。此步骤只准备编译依赖，不创建或填充签名身份、公钥、feed 或生产更新策略；必须等待当前提交的原生 CI 实际通过，不能把脚本存在视作链接成功。

`collect.py` 将各平台 `package-evidence.json` 与最终安装器一起收集并加入 checksum。桌面证据保留实际 Cargo features、入口和签名后 binary hash；Android 证据绑定最终 APK、两 ABI 库 hash、实际新 DEX 类、manifest 组件、签名与对齐校验。所有静态证据都明确 `runtime_validation=not-run`，不代替安装/业务验收。

## 尚未完成的实机验收

- 本地 Linux fixture 测试不构建或运行 Windows/macOS 安装器。需原生 runner 编译、签名和安装卸载验证，检查包内二进制与证据一致。
- ffmpeg/ffplay 目前未打入包；必须补齐媒体依赖分发/许可、动态依赖闭包、摄像头/麦克风/屏幕权限和真实会议/共享测试，不能仅依据 feature 宣称媒体可用。
- 必须验证真实组织登录、授权隔离、聊天、会议、文件收发/取消、更新门，以及 Windows helper/Sparkle 实际强制更新（含失败、缓存恢复和重启后在线策略复核）。
- macOS 框架架构、Sparkle 实际版本行为、签名/公证/安装后加载尚需真实平台验收。当前改动只修正安装器输入接线，不代表三端已交付。
