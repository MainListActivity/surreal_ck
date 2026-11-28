Status: ready-for-human

# 11 · 协同 APP 正式签名分发、更新供应链与原生安全验收

**目标**：关闭 `native-client/README.md` 记录的全部发布阻塞项，使种子律所能够通过正规安装包一键安装、安全自动更新 macOS / Windows（及按需 Android）协同客户端，不再停留在无签名的内部预览包。

## 范围

1. **生产更新信任根与签名凭据**（需老板人工配置）：补齐生产更新公钥、固定更新 feed 地址、macOS Apple Developer ID 签名与公证（Notarization）凭据（及 Windows 代码签名证书，若有），使企业安装包通过系统安全门禁且正常启停更新校验。
2. **桌面媒体运行时可信供应链**：锁定桌面端 WebRTC/媒体依赖的固定版本与 SHA-256 清单，确保 CI 产出的 macOS（arm64/x64）与 Windows 安装包均通过最终包静态清单校验。
3. **原生安全文件接收全量 CI 验收**：完成 `native-client/README.md` 遗留的真实 Transfer/子进程中断检查及 Windows/macOS 原生安全接收（防路径穿越、防 symlink 攻击、原子落盘）CI 验收后，再决定开启生产接收开关。
4. **全新机器安装与升级实测**：在未安装过开发工具的干净 macOS 与 Windows 设备上验证“下载安装 → 启动首屏 OIDC 登录 → 收到新版更新提示并重启升级成功”。

## 非目标

- 本任务不新增业务功能；不以静态包校验通过代替真机安装与升级验收。

## 独立验收标准

- [ ] CI 成功产出经 Apple Developer ID 签名并公证通过的 macOS DMG 与带完整运行时的 Windows 安装包，附各制品 SHA-256 清单。
- [ ] 生产更新信任根与 feed 生效：干净设备安装版本 `N` 后，发布版本 `N+1` 可正常检测到更新、校验签名并重启切换到 `N+1`；篡改签名或无信任根时 fail-closed 拒绝更新。
- [x] Windows/macOS 原生候选接收通过 CI，包括中断时的提交边界、中断后新传输、symlink 负例及生产禁用回归。生产启用另验。
- [ ] 在干净用户机器上完成真实安装、登录、进会、更新全流程并留存脱敏验收记录。

**依赖**：`02`、`03`、`04`（人工凭据准备可提前并行）。  
**验证方式**：原生 GitHub Actions 构建回执 + Apple Notarization 回执 + 干净设备真机实测。

## 2026-11-28 非凭据发布门复核

以主干 `3fd77731` 为基线。已核对 [#319](https://github.com/MainListActivity/surreal_ck/pull/319) 的桌面打包及 [#327](https://github.com/MainListActivity/surreal_ck/pull/327) 的 Windows 签名策略。

| 门禁 | 已核实结果 |
| --- | --- |
| 原生安全接收 | [#319 原生 CI](https://github.com/MainListActivity/surreal_ck/actions/runs/45988018879) 实际执行三个目标。macOS arm64 与 x64 各通过 10 项探针、27 项 Transfer、2 项生产禁用检查。Windows x64 通过 12 项默认探针、单独执行 3 项 symlink 负例、28 项 Transfer、2 项生产禁用检查。三个目标均由父测试终止实际传输子进程，覆盖部分接收、已保存待 ACK 两个检查点及之后的新传输。生产接收保持关闭，遗留暂存自动回收、真实磁盘耗尽与跨用户隔离仍需另验。 |
| 媒体运行时 | [主干候选 CI](https://github.com/MainListActivity/surreal_ck/actions/runs/45790178370) 的三个候选各通过 5 项原生合成检查。下载产物后复核清单 SHA-256 和全量文件哈希，macOS arm64 / x64 各 36 个文件，Windows x64 51 个。正式锁尚未批准，`release-media-input.py lock` 对三个目标均拒绝放行。Windows 历史静态审计条目仅保留原始记录。 |
| 打包与更新 | [#327 普通 CI](https://github.com/MainListActivity/surreal_ck/actions/runs/45995281069) 构建并静态校验 Windows 未签名安装器和 Android 测试签名包，macOS 双架构完成渲染与入口检查。macOS 正式打包、安装 smoke 及正式发布验证步骤均跳过。[主干正式打包尝试](https://github.com/MainListActivity/surreal_ck/actions/runs/45996726357) 在桌面媒体锁及 Linux/Android 公开身份与更新输入预检停止。Windows 未签名包可用于安装验收，正式强制更新要求 Authenticode。 |

本次修正正式 macOS 打包继承预览 feature 导致启动跳过验签的问题。正式打包拒绝预览产物，客户端在选中任何平台强制更新器或嵌入更新配置时仍走强制更新。发布预检用最终安装器回执绑定包证据的 SHA-256，核对源码、目标、更新配置、媒体清单、签名状态及在线更新策略。移除了正式桌面证据中固定写入、发布预检却要求为真的 `release_eligible` 字段。旧回执需重新打包取得绑定证据。

Apple Silicon 本地验证使用 Rust 1.99.1。客户端默认 94 项、手动预览 97 项、正式 macOS 143 项、正式 macOS 叠加预览 feature 143 项，均通过并通过严格 Clippy。`check-renderer.sh macos` 使用固定 SHA-256 的 Sparkle SDK，原生 renderer 30 项和实验宿主注册 5 项通过，并单独运行混合 feature 启动负例，确认缺信任配置时锁定。Transfer 27 项通过，独立夹具入口由父测试调用，生产禁用 2 项、原生候选探针 10 项及 updater 33 项通过，对应 Clippy 全绿。桌面发布与打包 Python 套件 179 项中 163 项通过，15 项 Linux 专用 Android smoke 和 1 项缺本机 PowerShell 跳过。

## 待人工输入与终验

- **生产身份与更新**。注册原生 OIDC 客户端及回调，配置公开客户端参数、生产 Ed25519 策略公钥与固定 HTTPS 策略地址，以及受控签名、发布和策略续期。macOS 还需配套的 Sparkle 发布公钥、签名供给与固定 appcast。
- **平台签名**。macOS 使用现有 Developer ID Application 身份与 App Store Connect 公证凭据，验证 DMG 签名、公证及 stapling。Windows 在进入强制更新渠道前须提供可用于应用和安装器签名的 Authenticode 证书。当前完整生产矩阵还需要稳定的 Android 发布签名。
- **媒体再分发**。审核对应源码、许可证、运行时依赖及分发留存，签好 macOS 媒体组件，固定三个获批输入的构建运行与清单 SHA-256，然后重跑生产安装器矩阵和最终包校验。
- **设备回执**。干净的 macOS 与 Windows 机器完成安装、系统浏览器 OIDC 登录、进会、所启用的媒体及文件路径，并验证从 N 到 N+1 的签名核对、安装和重启后的版本。Android 在纳入发布时取得同等设备回执。
