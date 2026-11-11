# Windows 安装启动冒烟

仅在一次性 Windows CI runner 上运行。此脚本会执行真实 Inno 安装/卸载，安装器仍可能创建 HKCU 卸载记录；不是完整沙箱，不能用于有既存 SurrealCK 安装的用户电脑。

下载同一次构建的 Windows artifact 后传入精确文件路径，不以 glob 随机选择：

```powershell
./scripts/native-client/windows-install-smoke.ps1 `
  -SetupPath ./download/SurrealCK-windows-x64-setup.exe `
  -PackageEvidencePath ./download/windows-windows-latest-package-evidence.json `
  -BuildReceiptPath ./download/windows-windows-latest-build-receipt.json `
  -EvidenceDir ./dist/windows-install-smoke
```

上例 receipt 文件名中的 runner 必须按 collect.py 实际输出调整。CI 应依赖对应打包 job，checkout 同一个 commit，使用 `windows-latest`、`shell: pwsh`，设置 job timeout，并以 `if: always()` 上传整个 evidence 目录。不得设置 continue-on-error 以伪装通过。

脚本验证下载 setup 的文件名、大小、SHA256，并核对包证据与构建 receipt 的 source/commit/version/build；安装后的实际 `surreal-collaboration.exe` 必须等于包证据的签名后 SHA256。拒绝含内嵌更新配置的构建，只允许 `absent-blocked`，不提供服务配置、不操作门禁、不申请设备权限。LOCALAPPDATA 仅对被启动应用隔离到临时目录，随后恢复。

真实 exe 必须存活至少 20 秒（默认 25 秒），最后有可见、响应的主窗口；无交互桌面/窗口时失败，不模拟通过。保存 stdout/stderr、安装日志、相关 Application Error/WER/.NET 崩溃事件、JSON 和可读 TXT。能截图时仅保存窗口所在屏幕区域，可能被其他窗口遮挡；截图需人工查看，不能据此自动宣称锁定页正确。崩溃事件查询失败也失败；截图失败单独标记 unavailable。

结果只是安装和窗口存活证据，不证明登录、聊天、会议、文件、设备、更新成功，也不使 release eligible。退出后停止本次进程并静默卸载、删除临时目录；清理失败会使测试失败。需结合 JSON、日志和截图解释 CI 结果。

Linux 上仅可运行静态契约检查：

```sh
python -m unittest discover -s scripts/native-client -p test_windows_smoke.py -v
```

有 pwsh 时还会用 PowerShell parser 校验语法；这些测试不构成 Windows 安装运行证据。
