# Android 安装与启动 smoke 的验收边界

脚本只在隔离 AVD 中安装指定 APK、启动 Activity、等待 20 秒并保存诊断；不授予权限、不关闭 ANR 对话框、不配置登录、不绕过更新门。

- 安装、启动、进程存活和 GUI 环境分别记录在 `smoke-result.json`。系统或应用 ANR、非应用窗口占用焦点、应用崩溃、关键诊断缺失均返回非零状态，并保留已通过阶段的 partial 结果。
- 不能把 `topResumedActivity`、`mFocusedApp` 或 PID 当作 GUI 成功。实际 `mCurrentFocus=Window{… Application Not Responding: com.android.systemui}` 必须失败。截图仍需人工检查；自动检查通过也不代表登录、聊天、会议、文件或真实更新链路通过。
- Boot 默认最多 1800 秒墙钟时间，每次 ADB 查询最多 10 秒，并按剩余时间缩短。整个脚本工作阶段最多 2250 秒（含 SDK 准备），余下时间用于有限诊断/清理，适配 40 分钟 CI job。工作时间不足时，实际 boot 预算会缩短并写入 `timing.txt`。`ANDROID_SMOKE_BOOT_TIMEOUT_SECONDS` 仅允许 1..1800，方便缩短回归测试；不再把180次不定长查询误称15分钟。
- 安装最多300秒、Activity启动最多120秒，诊断命令分别限制10..20秒；GNU timeout 额外保留最多2秒强制终止宽限。失败也保存可取得的截图、窗口焦点和日志。AVD/SDK镜像不放入上传证据目录。

## 明确选择的低负载 profile

`ANDROID_SMOKE_PROFILE` 只接受两个固定值，不接受任意系统镜像、路径或模拟器参数：

- `google-api35`（默认）：保留 `system-images;android-35;google_apis;x86_64`、Pixel 7 及设备默认显示配置。
- `aosp-api35-low-resolution`：固定 `system-images;android-35;default;x86_64`、320×640 framebuffer、160 dpi。仅修改本次新建的临时 AVD config.ini 的 `hw.lcd.width/height/density`，使用受支持的 `-skin 320x640`；不使用已废弃、会被忽略的 `-dpi-device`。

独立 workflow 可显式设置 `ANDROID_SMOKE_PROFILE: aosp-api35-low-resolution`；本补丁不修改任何 workflow 的选择。脚本记录 `profile.json`（所选镜像、设备、AVD显示配置、参数），启动后只读查询实际 `wm size` 和 `wm density` 并保存到证据与结果中。选择低负载 profile 不会降低 ANR/窗口焦点/崩溃失败标准，也不会更改 KVM、系统权限或更新门禁。

选择依据：此前两个 Google APIs/TCG 运行分别出现 System UI ANR，以及 PackageManager Broken pipe + 多个系统进程 DeadSystemException。后者表示模拟器系统/服务失效、安装未确认，不能归因为应用崩溃。当前只验收缺更新配置的锁定页，不需要 Google Play 服务；AOSP及较低分辨率有望减少后台/渲染负载，但还没有运行证据证明改善。

已有真实工具验证仅证明 Android 35 default 镜像可由 avdmanager 创建且 emulator 能在相同隔离目录发现；新的低负载 profile 已做参数/负向回归，尚未启动本地模拟器或声称安装、启动、交互通过。下一轮运行应与 Google APIs 结果分开标示并保留同样的完整诊断。
