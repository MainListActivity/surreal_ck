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
- [ ] Windows/macOS 安全文件接收（含中断恢复与 symlink 负例）在原生 CI 全部通过。
- [ ] 在干净用户机器上完成真实安装、登录、进会、更新全流程并留存脱敏验收记录。

**依赖**：`02`、`03`、`04`（人工凭据准备可提前并行）。  
**验证方式**：原生 GitHub Actions 构建回执 + Apple Notarization 回执 + 干净设备真机实测。
