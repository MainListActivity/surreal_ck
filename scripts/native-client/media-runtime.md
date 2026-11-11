# 桌面媒体运行时随包交付评估（尚未接入默认发布）

## 结论与边界

当前安装包不含 ffmpeg/ffplay；仅在 CI apt/brew 安装它们不能满足用户安装后直接使用。此文与同名审计脚本不改变已有 package 脚本，不代表正式安装包已验证。Android 不适用桌面 FFmpeg 进程方案。

2026-11-10 核实来源：

- [FFmpeg 官方下载页](https://ffmpeg.org/download.html) 明确项目只发布源码，链接 Gyan/BtbN Windows 构建与 evermeet macOS 构建。
- [Gyan 构建页](https://www.gyan.dev/ffmpeg/builds/)提供 Windows x64 静态 ffmpeg、ffplay、ffprobe，9.0.2 essentials 有 libvpx、libopus、SDL2，适合当前子进程调用。该发行包是 GPLv3，不能标成 LGPL。当前发行要求 Windows 10 或以后。
- [固定 ZIP 的发布 SHA256](https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip.sha256)：`60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba`。
- [同版本发布及 FFmpeg 源码指向](https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2)给出上游 FFmpeg revision `946fcce07b`。这不能替代所有静态链接第三方库的对应源码/构建材料。
- [evermeet](https://evermeet.cx/ffmpeg/)提供 Intel ffmpeg/ffplay；其[ARM说明](https://evermeet.cx/ffmpeg/apple-silicon-arm)明确不提供 Apple Silicon 原生构建，因此不能拿 Intel 包冒充 aarch64。不可把 Rosetta 自动安装当作免依赖交付。
- [FFmpeg 许可说明](https://ffmpeg.org/legal.html)与实际包内许可证是合规核验起点；分发时需保留适用许可证、版权、完整对应源码及构建修改说明。使用独立子进程不免除二进制再分发义务。最终合规结论需项目方审查，不能仅给上游首页链接就声明已满足所有义务。

## 建议实施顺序

1. Windows：对固定版本 ZIP 验证仓库固定 SHA256，提取 ffmpeg.exe/ffplay.exe 到 app 相邻 `media-runtime/bin`。保留整个发行包的 LICENSE/README；收齐 FFmpeg 与静态依赖的对应源码和构建脚本后，作为同版本 sources 包与许可证随发布保存。先在 Windows runner 做 PE 导入闭包审计、空 PATH 启动、VP8/Opus编解码及 ffplay SDL dummy 播放；再接 Inno 文件列表。安装包声明 GPLv3 第三方组件，不能改变项目本身许可证以代替合规审核。
2. macOS ARM/Intel：优先从固定官方源码构建最小 FFmpeg + libvpx + libopus + SDL（排除 nonfree 与不需要的 GPL codec），保留各来源归档哈希和构建参数。原生 CI 分别构建，不从 Homebrew 随意拷贝单个 executable。此方案比全面第三方 FFmpeg 静态包更易控制依赖和对应源码，但需真实双架构编译才能写入可交付锁清单。
3. macOS 运行时布局 `Contents/Resources/media-runtime/bin` 与 `lib`。用 otool 遍历全部 Mach-O，拒绝 `/opt/homebrew`、`/usr/local` 或构建目录绝对依赖；非系统依赖收进 lib，再以 `@loader_path`/已核验 `@rpath` 重写。SDL框架/资源亦须闭合。先签内部 dylib/executable，再签 app，再公证/DMG；重写后必须重签，不能复用旧签名。
4. Linux 当前明确依赖发行版 GTK4/GStreamer、FFmpeg/ffplay（libvpx/libopus、Pulse/V4L2/X11支持）。这仍不是“所有依赖随包”的安装形式，下载说明要写明。若后续做 AppImage，另行处理 LGPL/GPL 对应源码及 glibc/音视频系统边界，不把构建机依赖当成目标机已具备。

## 发布阻断条件

没有完整对应源码材料、真实平台执行结果或原生动态依赖闭包，不将运行时加入默认发布；SHA256 只能证明字节一致，不证明运行、版权或代码签名可信。

当前需要的决策是确认可分发 GPLv3 第三方组件及对应源码托管方式，或选择自行构建尽量 LGPL 的最小组件集；这不是要求购买、开账号或创建凭据。macOS/Windows runner 权限仍沿用父任务限制，不能借本任务规避被拒发布路径。

## 本地已完成的真实只读审计

Gyan 9.0.2 essentials ZIP 实际下载完成，114,768,076 字节，SHA256 与上方固定发布值一致。归档含 GPLv3 LICENSE 与详细构建 README；已提取 ffmpeg.exe/ffplay.exe 供审计，未运行、未进入应用包。objdump 确认为 Windows x86-64；两程序的静态 PE imports 仅需所列 Windows 系统/UCRT DLL，没有发现归档外非系统静态导入。此结论不覆盖运行时 LoadLibrary、可选硬件驱动或实际声音/显示设备。

- ffmpeg.exe SHA256：`3256173f3f8bffd7df12227c68adf68025edb1832273a9530688a7bb1ed8edec`。
- ffplay.exe SHA256：`befbbd00a25965365f7fb3eed6ad5aa5f805eb70fabc567883a006de3b26c06f`。

运行时执行、对应源码完整性与 macOS 双架构依赖仍未验收，不启用默认捆绑。

## App-local 查找与离线打包输入契约

`native-media-platform/src/desktop_runtime.rs` 现为桌面媒体三个生产子进程入口解析工具：
Windows `<app.exe 所在目录>/media-runtime/bin/{ffmpeg,ffplay}.exe`；
macOS `Contents/Resources/media-runtime/bin/{ffmpeg,ffplay}`。
Windows/macOS 不回退 PATH、不支持环境变量覆盖，不下载或运行安装器；缺失时返回可定位的安装错误。
Linux 保持已声明的发行版 PATH 依赖。路径测试可在 Linux 运行，但不是 Windows/macOS 运行证据。

打包器接口（调用者负责将已验证目录纳入完整安装包）：

```sh
python3 scripts/native-client/prepare-media-runtime.py \
  --source /reviewed/runtime-tree \
  --manifest /reviewed/runtime-manifest.json \
  --manifest-sha256 <独立固定的64位小写SHA256> \
  --platform windows --arch x86_64 \
  --destination /staging/app/media-runtime
```

macOS destination 是 `.app/Contents/Resources/media-runtime`，arch 分别使用 `aarch64` 或 `x86_64`。
目标目录必须不存在且位于输入目录外；校验失败不复制。脚本不下载或执行 ffmpeg/ffplay，只调用本机 objdump/otool 作静态检查。
复制后仍须做目标平台原生安装/无开发工具环境测试；macOS 在重写依赖后、最终签名前准备运行时。

manifest 是**审查后的构建输入**，不是自动产生的信任凭证：构建配置须独立固定其 SHA256，不能从同一可变下载处获取 manifest 与期望 hash 后视为可信。
必填结构：

- `schema: 1`、`platform: "windows"|"macos"`、`arch: "x86_64"|"aarch64"`。
- `release_approved: true`：发布负责人对来源、许可证和对应源码完成审查后才填写，脚本不能证明法律义务完整。
- `files`：运行时树内**每个**文件相对 POSIX 路径到 SHA256 的对象；包括全部可执行文件、DLL/dylib、许可证、源代码归档、构建材料和测试证据。不接受符号链接、额外文件或路径穿越。
- `origins`：所有供应链归档的 `url`（HTTPS）、固定 `version`、`sha256`；来源必须经人工验证为官方或可信发布者，不能靠填写字段自证。现有 lock 只提供待审计候选，不是 release manifest。
- `license_files`、`corresponding_sources`、`build_records`：非空相对路径数组，必须全部列入 files。静态链接依赖的对应源码和构建修改亦须包含，不能仅放 FFmpeg 首页链接。
- `native_test_evidence`：已列入 files 的 JSON 路径，含相同 `platform/arch` 及 `clean_path`、`vp8_roundtrip`、`opus_roundtrip`、`ffplay_dummy`、`device_backends_listed`，各为 `"passed"`。证据应记录真实 runner、执行命令、日志与时间；禁止用 Linux 的测试结果或模拟输出填充 Windows/macOS 证据。设备后端枚举仅查询编译能力，不能启动用户设备。

脚本检查两个主程序 PE/薄 Mach-O 架构、全树 hash 与静态导入闭包。Windows 非系统 DLL 必须位于 bin；macOS 仅允许系统路径和可解析的包内 loader/executable-relative 路径，尚不接受未经验证的 rpath。静态检查不覆盖运行时动态加载、硬件驱动、沙盒/TCC 或签名兼容性，必须保留原生测试门槛。

当前没有满足条件的 release manifest：Windows 缺完整源码/合规审查和原生运行记录；macOS 缺固定来源构建产物、两架构依赖闭包和原生测试。这是明确发布阻碍，不是脚本失败或新授权被拒。本次未下载/运行候选二进制、未触发摄像头/麦克风/屏幕权限、未创建凭据或发布。
